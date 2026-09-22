// Sidecars whose picture has gone, and the pictures they belong to.
//
// A Google Photos export keeps each picture's metadata in a JSON file beside
// it, paired by filename and nothing else. Filing a picture into the artwork
// folder moves the picture and leaves the JSON, so the pair is broken and
// neither half can find the other: describing the artwork folder finds no
// sidecar, and describing the export builds its groups from pictures, so an
// orphaned JSON is never even looked at.
//
// Nothing needs to be moved to put that right. A sidecar's contents only
// matter until they have been read once — after that they live in the
// catalogue against the picture's content hash, which survives moving,
// renaming and every duplicate copy of that content. So this reads the
// orphans and works out which picture each belongs to.
//
// Matching is by name and then corroborated by time. A name on its own is
// not enough: an export is full of IMG_0001.jpg, and attaching one picture's
// date and place to another would be worse than leaving it undescribed. The
// sidecar's own capture time must agree with what the picture records about
// itself, which is the same test the Takeout check uses to vouch for a photo
// it cannot pair by name.
import { listFolder, walkTree, deleteFile, type JottaEntry, type MountpointRef } from '@/lib/api'
import {
  loadMetadataSidecar,
  deriveTagsFromMetadata,
  hasImportableTags,
  type GooglePhotosMetadata,
} from '@/lib/googlePhotosMetadata'
import { readArtworkMetadata } from '@/lib/imageMetadata'
import {
  ensureCategoriesForTags,
  loadMetadataForFolder,
  saveArtworkChanges,
  type ArtworkTags,
  type Category,
} from '@/lib/metadata'

/** `IMG_0193.PNG.supplemental-metadata.json` → `IMG_0193.PNG`. Google
 *  truncates that middle part on long names, so any leading piece of it
 *  counts. */
export function pictureNameForSidecar(name: string): string {
  const base = name.replace(/\.json$/i, '')
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const tail = base.slice(dot + 1).toLowerCase()
    if (tail.length > 0 && 'supplemental-metadata'.startsWith(tail)) return base.slice(0, dot)
  }
  return base
}

/** Filing renames on a collision, so `IMG_0193 (2).png` is still the picture
 *  that `IMG_0193.png` names. Compared without case, because an export and a
 *  tool that wrote it can disagree about that. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ \(\d+\)(\.[^.]+)$/, '$1')
}

export type Orphan = {
  sidecar: JottaEntry
  /** The picture it names, which is not in the folder the sidecar is in. */
  pictureName: string
}

export type Reunion = {
  orphan: Orphan
  /** Where the picture turned out to be. */
  picture: JottaEntry
  /** Whether the picture's own capture time agrees with the sidecar's. Only
   *  agreeing pairs are written; the rest are reported for a human to look
   *  at rather than guessed about. */
  confirmed: boolean
  why: string
}

export type ReuniteReport = {
  sidecarsSeen: number
  orphans: number
  /** Orphans whose picture wasn't anywhere in the artwork folder either. */
  unmatched: number
  matched: Reunion[]
  described: number
  /** The sidecars whose contents are now in the catalogue. Only these are
   *  safe to clear out: everything else here still holds the only copy of
   *  something. */
  describedSidecars: string[]
}

/**
 * Removes sidecars whose contents have been saved. They go to Jottacloud's
 * trash like anything else this app removes.
 *
 * Deliberately takes the paths rather than working them out again: the only
 * ones that may go are the ones a run has just written, and asking the
 * caller to hand them back is what keeps that true.
 */
export async function removeSidecars(
  loc: MountpointRef,
  paths: string[],
  opts?: { onProgress?: (done: number, total: number) => void }
): Promise<{ removed: number; failed: { name: string; error: string }[] }> {
  const failed: { name: string; error: string }[] = []
  let removed = 0
  let done = 0
  for (const path of paths) {
    try {
      await deleteFile(loc, path)
      removed++
    } catch (err) {
      failed.push({
        name: path.split('/').pop() ?? path,
        error: err instanceof Error ? err.message : 'Could not remove it.',
      })
    }
    opts?.onProgress?.(++done, paths.length)
  }
  return { removed, failed }
}

const READ_CONCURRENCY = 6
/** A capture time either side of a whole number of quarter-hours from the
 *  sidecar's is the same moment read in a different time zone. */
function sameMoment(embedded: number | undefined, takenAt: number | undefined): boolean {
  if (embedded == null || takenAt == null) return false
  if (embedded % 86400 === 0) return false
  const diff = embedded - takenAt
  return Math.abs(diff) <= 14 * 3600 && diff % 900 === 0
}

/**
 * Finds sidecars in `exportPath` whose picture is no longer beside them.
 *
 * Read from the folder listings alone — no JSON is fetched — so this is one
 * request per folder however many thousands of sidecars there are.
 */
export async function findOrphanSidecars(
  loc: MountpointRef,
  exportPath: string,
  opts?: { onProgress?: (folders: number, orphans: number) => void; signal?: AbortSignal }
): Promise<{ orphans: Orphan[]; sidecarsSeen: number; folders: number }> {
  const { folderRelPaths } = await walkTree(loc, exportPath, { signal: opts?.signal })
  const folders = ['', ...folderRelPaths].map((rel) => [exportPath, rel].filter(Boolean).join('/'))

  const orphans: Orphan[] = []
  let sidecarsSeen = 0
  let done = 0

  for (const folder of folders) {
    if (opts?.signal?.aborted) break
    const listing = await listFolder(loc, folder).catch(() => null)
    done++
    if (!listing) continue
    const present = new Set(
      listing.files.filter((f) => !f.name.toLowerCase().endsWith('.json')).map((f) => nameKey(f.name))
    )
    for (const file of listing.files) {
      if (!file.name.toLowerCase().endsWith('.json')) continue
      sidecarsSeen++
      const pictureName = pictureNameForSidecar(file.name)
      if (!present.has(nameKey(pictureName))) orphans.push({ sidecar: file, pictureName })
    }
    opts?.onProgress?.(done, orphans.length)
  }

  return { orphans, sidecarsSeen, folders: folders.length }
}

/**
 * Works out which picture in `destPath` each orphan belongs to, and — unless
 * asked only to look — writes what the sidecar knows against that picture's
 * content hash.
 *
 * `dryRun` exists because this is the step where a wrong name match would
 * put one photograph's date and place on another. It reports what it would
 * write, with its reason for each, before anything is written.
 */
export async function reuniteOrphans(
  metadataLoc: MountpointRef,
  loc: MountpointRef,
  orphans: Orphan[],
  destLoc: MountpointRef,
  destPath: string,
  opts?: {
    dryRun?: boolean
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
  }
): Promise<ReuniteReport> {
  const report: ReuniteReport = {
    sidecarsSeen: 0,
    orphans: orphans.length,
    unmatched: 0,
    matched: [],
    described: 0,
    describedSidecars: [],
  }
  if (orphans.length === 0) return report

  // Every picture in the artwork folder, by name. Filing puts them all
  // directly in it, but the walk covers anything below it too in case the
  // destination is organised some other way.
  const dest = await walkTree(destLoc, destPath, { signal: opts?.signal })
  const byName = new Map<string, JottaEntry[]>()
  for (const file of dest.files) {
    const name = file.absPath.split('/').pop() ?? ''
    const key = nameKey(name)
    const held = byName.get(key) ?? []
    held.push({ name, path: file.absPath, isFolder: false, md5: file.md5 })
    byName.set(key, held)
  }

  let cursor = 0
  let done = 0
  const found: Reunion[] = []
  const metaByPath = new Map<string, GooglePhotosMetadata>()

  async function worker() {
    for (;;) {
      if (opts?.signal?.aborted) return
      const orphan = orphans[cursor++]
      if (!orphan) return
      const candidates = byName.get(nameKey(orphan.pictureName)) ?? []
      if (candidates.length === 0) {
        report.unmatched++
        opts?.onProgress?.(++done, orphans.length)
        continue
      }

      const sidecarData = await loadMetadataSidecar(loc, orphan.sidecar).catch(() => null)
      if (!sidecarData || !hasImportableTags(sidecarData)) {
        report.unmatched++
        opts?.onProgress?.(++done, orphans.length)
        continue
      }
      metaByPath.set(orphan.sidecar.path, sidecarData)

      // One name, possibly several pictures: the one whose own capture time
      // agrees is the one this sidecar is about.
      let chosen: JottaEntry | null = null
      let confirmed = false
      let why = 'name only — the picture records no capture time of its own'
      for (const candidate of candidates) {
        const embedded = await readArtworkMetadata(destLoc, candidate.path)
          .then((m) => m?.dateTakenAtEpochSeconds)
          .catch(() => undefined)
        if (sameMoment(embedded, sidecarData.photoTakenAtEpochSeconds)) {
          chosen = candidate
          confirmed = true
          why = 'name and capture time agree'
          break
        }
        if (!chosen) chosen = candidate
        if (embedded != null) why = 'name matches, but the capture times disagree'
      }

      if (chosen) found.push({ orphan, picture: chosen, confirmed, why })
      else report.unmatched++
      opts?.onProgress?.(++done, orphans.length)
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))

  report.matched = found
  if (opts?.dryRun) return report

  // Only the confirmed ones are written. An unconfirmed match is reported
  // and left alone: the cost of guessing wrong is one picture wearing
  // another's date and place, which is worse than no date at all.
  const { store } = await loadMetadataForFolder(metadataLoc, { ...destLoc, path: destPath })
  const existingByMd5 = new Map(store.artworks.map((a) => [a.md5, a]))
  let categories: Category[] = store.categories
  const upsert: ArtworkTags[] = []
  const now = new Date().toISOString()

  for (const reunion of found) {
    if (!reunion.confirmed || !reunion.picture.md5) continue
    const data = metaByPath.get(reunion.orphan.sidecar.path)
    if (!data) continue
    const tags = deriveTagsFromMetadata(data, existingByMd5.get(reunion.picture.md5)?.tags ?? {})
    if (Object.keys(tags).length === 0) continue
    categories = ensureCategoriesForTags(categories, tags)
    upsert.push({
      md5: reunion.picture.md5,
      device: destLoc.device,
      mountpoint: destLoc.mountpoint,
      path: reunion.picture.path,
      lastSeenAt: now,
      tags,
    })
    report.described++
    report.describedSidecars.push(reunion.orphan.sidecar.path)
  }

  if (upsert.length > 0) await saveArtworkChanges(metadataLoc, categories, { upsert })
  return report
}
