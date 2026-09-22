// Describing pictures the moment they arrive.
//
// Copying a picture in used to leave it invisible to the catalogue: its date,
// camera and place sat in the file, and in any Google sidecar beside it, but
// nothing read them until someone remembered to run the bulk import. So a
// folder of freshly copied photos could not be found by date, or by anything
// else, while looking perfectly present in Jottacloud.
//
// This reads the same sources the bulk import reads, for a known list of
// files rather than a whole tree, and saves what it finds. Tags are keyed by
// content hash, so describing a copy describes that content wherever else it
// lives too.
import { listFolder, type JottaEntry, type MountpointRef } from '@/lib/api'
import { deriveTagsForFile } from '@/lib/batchTagImport'
import {
  ensureCategoriesForTags,
  loadMetadataForFolder,
  saveArtworkChanges,
  type ArtworkTags,
  type Category,
} from '@/lib/metadata'

export type AutoDescribeResult = {
  described: number
  /** Nothing to add: the file carries no properties and has no sidecar, or
   *  it is already described with exactly these tags. */
  unchanged: number
  failed: number
}

const FILE_CONCURRENCY = 6

function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Describes the given files, which must all be in one place, and saves the
 * result to the catalogue at `metadataLoc`.
 *
 * `rootPath` is the folder they were copied into: the catalogue is loaded for
 * that folder, so pictures already described keep their existing tags rather
 * than being written over with only what the file says.
 */
export async function describeArrivedFiles(
  metadataLoc: MountpointRef,
  loc: MountpointRef,
  rootPath: string,
  paths: string[],
  opts?: {
    onProgress?: (done: number, total: number) => void
    /** Where each arrival came from. A Google Photos export keeps a picture's
     *  metadata in a sidecar file beside it, and moving the picture leaves
     *  that sidecar behind — so the folder it came out of is searched too,
     *  and a piece taken out of an export keeps what the export knew. */
    cameFrom?: Map<string, { device: string; mountpoint: string; path: string }>
  }
): Promise<AutoDescribeResult> {
  if (paths.length === 0) return { described: 0, unchanged: 0, failed: 0 }

  const wanted = new Set(paths)
  const folders = [...new Set(paths.map(folderOf))]

  // Listed once each and shared: several arrivals usually come out of one
  // folder, and this is a request apiece.
  const origins = new Map<string, JottaEntry[]>()
  async function originSiblings(from: { device: string; mountpoint: string; path: string }) {
    const folder = folderOf(from.path)
    const key = `${from.device}/${from.mountpoint}/${folder}`
    const held = origins.get(key)
    if (held) return held
    const listing = await listFolder(
      { device: from.device, mountpoint: from.mountpoint },
      folder,
      { includeDeleted: true }
    ).catch(() => null)
    const files = listing?.files ?? []
    origins.set(key, files)
    return files
  }

  // One listing per folder, shared by every file in it: the sidecar search
  // needs a picture's siblings, and deleted ones count — a sidecar can pair
  // with a name that a past dedupe run removed.
  const groups: { liveEntry: JottaEntry; namesToTry: string[]; siblings: JottaEntry[] }[] = []
  for (const folder of folders) {
    const listing = await listFolder(loc, folder, { includeDeleted: true })
    for (const file of listing.files) {
      if (file.deleted || !file.md5 || !wanted.has(file.path)) continue
      const names = new Set(listing.files.filter((f) => f.md5 === file.md5).map((f) => f.name))
      let siblings = listing.files

      const from = opts?.cameFrom?.get(file.path)
      // Same mountpoint only: a sidecar is read back by its path, and that
      // path is resolved against the destination. Borrowing siblings from
      // another mountpoint would read whatever sits at that path there.
      if (from && from.device === loc.device && from.mountpoint === loc.mountpoint) {
        // The name it had before it was filed counts too: a sidecar pairs
        // with a filename, and filing can rename to avoid a collision.
        names.add(from.path.split('/').pop() ?? '')
        siblings = [...siblings, ...(await originSiblings(from))]
      }

      groups.push({ liveEntry: file, namesToTry: [...names].filter(Boolean), siblings })
    }
  }

  const { store } = await loadMetadataForFolder(metadataLoc, { ...loc, path: rootPath })
  const existingByMd5 = new Map(store.artworks.map((a) => [a.md5, a]))

  let cursor = 0
  let done = 0
  const results: { entry: JottaEntry; tags: Record<string, string[]> | null; error?: string }[] = []
  async function worker() {
    for (;;) {
      const group = groups[cursor++]
      if (!group) return
      // Both sources, always: a picture copied in from a phone backup has no
      // sidecar and everything in the file, while one from a Google export
      // has both, and the file holds what the sidecar never does.
      results.push(await deriveTagsForFile(loc, group, existingByMd5.get(group.liveEntry.md5!)?.tags, true))
      opts?.onProgress?.(++done, groups.length)
    }
  }
  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker))

  let categories: Category[] = store.categories
  const upsert: ArtworkTags[] = []
  const now = new Date().toISOString()
  let described = 0
  let unchanged = 0
  let failed = 0

  for (const { entry, tags, error } of results) {
    if (error) {
      failed++
      continue
    }
    if (!tags || Object.keys(tags).length === 0) {
      unchanged++
      continue
    }
    categories = ensureCategoriesForTags(categories, tags)
    upsert.push({
      md5: entry.md5 as string,
      device: loc.device,
      mountpoint: loc.mountpoint,
      path: entry.path,
      lastSeenAt: now,
      tags,
    })
    described++
  }

  if (upsert.length > 0) await saveArtworkChanges(metadataLoc, categories, { upsert })
  return { described, unchanged, failed }
}
