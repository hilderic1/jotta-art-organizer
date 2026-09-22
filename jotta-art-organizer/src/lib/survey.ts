// Where the pictures actually are.
//
// Jottacloud's Media view is a gallery over the whole account, so a photo can
// be plainly visible there while this app, which walks one device and one
// mountpoint at a time, never goes near it. Rather than guessing which of the
// two is wrong, this walks every device and mountpoint there is and counts
// what it finds in each.
//
// It counts files as well as pictures, and counts separately the files with
// no checksum — those are invisible to walkTree, and therefore to the look,
// the duplicate check and the empty-folder logic, while being perfectly
// present in Jottacloud. A folder of them looks empty to everything else in
// this app and looks full here, which is exactly the difference worth seeing.
import { listMountpoints, listFolder, unreadEntries, type MountpointRef } from '@/lib/api'
import { readArtworkMetadata } from '@/lib/imageMetadata'
import { artworkReason } from '@/lib/photoIntake'

const PICTURE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|cr2|nef|arw|orf|rw2)$/i

export function isPicture(name: string): boolean {
  return PICTURE_EXT.test(name)
}

export type FolderSurvey = {
  folders: number
  files: number
  pictures: number
  /** Files Jottacloud lists with no checksum. Everything else in this app
   *  skips these silently. */
  withoutHash: number
  /** Entries Jottacloud's own tally says are in a folder that never reached
   *  us — a listing read short rather than a folder read fully. */
  unread: number
  /** Paths of files whose name matched what was being looked for. */
  matches: string[]
  /** The deepest folder reached, as a sign of what shape the tree is. */
  deepest: number
  /** Pictures whose own properties say PicsArt or an AI tool made them.
   *  Only filled in when asked for: it costs a request per picture, against
   *  one per folder for everything else here. */
  artwork?: number
  /** How many pictures were actually read for that answer, so a stopped or
   *  partly failed pass doesn't read as "only this many are artwork". */
  artworkRead?: number
  error?: string
}

export type MountpointSurvey = FolderSurvey & {
  device: string
  mountpoint: string
}

const FOLDER_CONCURRENCY = 4
const MATCH_LIMIT = 50
/** Header reads run wider than folder listings: each one is a small ranged
 *  fetch, and there can be one per picture. */
const FILE_CONCURRENCY = 6

/**
 * Counts every file in every mountpoint, optionally noting where a named file
 * lives.
 *
 * This is a lot of requests — one per folder in the account — so it is a
 * button rather than something that runs on its own, and it can be called off.
 */
export type SurveyProgress = {
  /** Which mountpoint, counting from one, and how many there are. */
  index: number
  total: number
  mountpoint: string
  /** The folder being read at this moment, named in full. A walk of a big
   *  archive is minutes of silence otherwise, and silence is
   *  indistinguishable from being stuck. */
  path: string
  folders: number
  files: number
}

export async function surveyAccount(opts?: {
  /** Case-insensitive fragment of a filename to locate while walking. */
  nameContains?: string
  onProgress?: (progress: SurveyProgress) => void
  signal?: AbortSignal
}): Promise<MountpointSurvey[]> {
  const mountpoints = await listMountpoints()
  const wanted = opts?.nameContains?.trim().toLowerCase()
  const results: MountpointSurvey[] = []

  for (const [index, mp] of mountpoints.entries()) {
    if (opts?.signal?.aborted) break
    const where = `${mp.device}/${mp.mountpoint}`
    opts?.onProgress?.({
      index: index + 1,
      total: mountpoints.length,
      mountpoint: where,
      path: where,
      folders: 0,
      files: 0,
    })
    results.push({
      ...(await surveyFolder(mp, '', {
        nameContains: wanted,
        signal: opts?.signal,
        onProgress: (folders, files, _stage, path) =>
          opts?.onProgress?.({
            index: index + 1,
            total: mountpoints.length,
            mountpoint: where,
            path: path ? `${where}/${path}` : where,
            folders,
            files,
          }),
      })),
      device: mp.device,
      mountpoint: mp.mountpoint,
    })
  }

  return results
}

/**
 * Counts a folder and everything below it, however deep.
 *
 * One request per folder for the counts. Identifying artwork costs one more
 * per picture, so it's asked for rather than included — on a folder of
 * thousands that's the difference between seconds and a long wait.
 */
export async function surveyFolder(
  loc: MountpointRef,
  rootPath: string,
  opts?: {
    nameContains?: string
    detectArtwork?: boolean
    onProgress?: (
      folders: number,
      files: number,
      stage: 'listing' | 'reading',
      /** The folder just read, relative to where the walk started. */
      path?: string
    ) => void
    signal?: AbortSignal
  }
): Promise<FolderSurvey> {
  const wanted = opts?.nameContains?.trim().toLowerCase()
  const signal = opts?.signal
  const out: FolderSurvey = {
    folders: 0,
    files: 0,
    pictures: 0,
    withoutHash: 0,
    unread: 0,
    matches: [],
    deepest: 0,
  }

  // Kept only when it's going to be used: on a big tree this is the whole
  // library's worth of paths, and nothing else here needs them.
  const pictures: string[] = []

  // Depth carried with each folder: a tree of month/day folders and one
  // holding everything flat produce the same counts and want reading
  // differently.
  const queue: { path: string; depth: number }[] = [{ path: rootPath, depth: 0 }]
  let cursor = 0

  async function worker() {
    for (;;) {
      if (signal?.aborted) return
      const next = queue[cursor++]
      if (!next) return
      let listing
      try {
        listing = await listFolder(loc, next.path)
      } catch (err) {
        // One unreadable folder shouldn't lose the count for the rest of the
        // mountpoint — the first reason is kept and the walk goes on.
        out.error = out.error ?? (err instanceof Error ? err.message : 'Could not list a folder.')
        continue
      }
      out.folders++
      out.deepest = Math.max(out.deepest, next.depth)
      out.unread += unreadEntries(listing)
      for (const file of listing.files) {
        out.files++
        if (isPicture(file.name)) {
          out.pictures++
          if (opts?.detectArtwork) pictures.push(file.path)
        }
        if (!file.md5) out.withoutHash++
        if (wanted && out.matches.length < MATCH_LIMIT && file.name.toLowerCase().includes(wanted)) {
          out.matches.push(file.path)
        }
      }
      for (const sub of listing.folders) queue.push({ path: sub.path, depth: next.depth + 1 })
      // Relative to where this walk began, so a caller that started deeper
      // than the mountpoint root can name it however it likes.
      const rel = rootPath && next.path.startsWith(rootPath) ? next.path.slice(rootPath.length + 1) : next.path
      opts?.onProgress?.(out.folders, out.files, 'listing', rel)
    }
  }

  // Workers stop when the queue runs dry, but subfolders turn up mid-walk, so
  // rounds keep starting until one finds nothing left to visit.
  while (cursor < queue.length && !signal?.aborted) {
    await Promise.all(Array.from({ length: FOLDER_CONCURRENCY }, worker))
  }

  if (opts?.detectArtwork) {
    // The same test filing uses: what the file itself records about the tool
    // that made it, never the picture and never its name.
    let artwork = 0
    let read = 0
    let pIdx = 0
    async function reader() {
      for (;;) {
        if (signal?.aborted) return
        const path = pictures[pIdx++]
        if (path === undefined) return
        try {
          if (artworkReason(await readArtworkMetadata(loc, path))) artwork++
          read++
        } catch {
          // An unreadable header says nothing either way, so it counts as
          // neither artwork nor read rather than as "not artwork".
        }
        opts?.onProgress?.(out.folders, read, 'reading')
      }
    }
    await Promise.all(Array.from({ length: FILE_CONCURRENCY }, reader))
    out.artwork = artwork
    out.artworkRead = read
  }

  return out
}
