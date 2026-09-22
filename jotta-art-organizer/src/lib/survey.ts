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

const PICTURE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|cr2|nef|arw|orf|rw2)$/i

export type MountpointSurvey = {
  device: string
  mountpoint: string
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
  error?: string
}

const FOLDER_CONCURRENCY = 4
const MATCH_LIMIT = 50

/**
 * Counts every file in every mountpoint, optionally noting where a named file
 * lives.
 *
 * This is a lot of requests — one per folder in the account — so it is a
 * button rather than something that runs on its own, and it can be called off.
 */
export async function surveyAccount(opts?: {
  /** Case-insensitive fragment of a filename to locate while walking. */
  nameContains?: string
  onProgress?: (done: number, total: number, current: string) => void
  signal?: AbortSignal
}): Promise<MountpointSurvey[]> {
  const mountpoints = await listMountpoints()
  const wanted = opts?.nameContains?.trim().toLowerCase()
  const results: MountpointSurvey[] = []

  for (const [index, mp] of mountpoints.entries()) {
    if (opts?.signal?.aborted) break
    opts?.onProgress?.(index, mountpoints.length, `${mp.device}/${mp.mountpoint}`)
    results.push(await surveyOne(mp, wanted, opts?.signal))
  }

  opts?.onProgress?.(mountpoints.length, mountpoints.length, '')
  return results
}

async function surveyOne(
  loc: MountpointRef,
  wanted: string | undefined,
  signal: AbortSignal | undefined
): Promise<MountpointSurvey> {
  const out: MountpointSurvey = {
    device: loc.device,
    mountpoint: loc.mountpoint,
    folders: 0,
    files: 0,
    pictures: 0,
    withoutHash: 0,
    unread: 0,
    matches: [],
    deepest: 0,
  }

  // Depth carried with each folder: a mountpoint of month/day folders and one
  // holding everything flat produce the same counts and want reading
  // differently.
  const queue: { path: string; depth: number }[] = [{ path: '', depth: 0 }]
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
        if (PICTURE_EXT.test(file.name)) out.pictures++
        if (!file.md5) out.withoutHash++
        if (wanted && out.matches.length < MATCH_LIMIT && file.name.toLowerCase().includes(wanted)) {
          out.matches.push(file.path)
        }
      }
      for (const sub of listing.folders) queue.push({ path: sub.path, depth: next.depth + 1 })
    }
  }

  // Workers stop when the queue runs dry, but subfolders turn up mid-walk, so
  // rounds keep starting until one finds nothing left to visit.
  while (cursor < queue.length && !signal?.aborted) {
    await Promise.all(Array.from({ length: FOLDER_CONCURRENCY }, worker))
  }

  return out
}
