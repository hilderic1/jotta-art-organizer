// Finding the catalogue, and not losing it again.
//
// Which mountpoint holds the catalogue is the one thing that cannot itself be
// stored in the catalogue, so it lives on the device — and a reconnect used to
// wipe it, leaving everything built on it unreachable with nothing on screen
// saying why. Worse, answering the question wrongly starts a second, empty
// catalogue somewhere else, which looks exactly like the first one having
// been emptied.
//
// So: the account is searched for catalogues, each one weighed by what is
// actually in it, and the answer is remembered on the device as well as in
// the session. A real catalogue and a stray empty one are then telling apart
// at a glance rather than by guessing at mountpoint names.
import { listMountpoints, listFolder, jottaTime, type MountpointRef } from '@/lib/api'

const STORE_FOLDER = '.jotta-art-organizer'
const SHARDS_FOLDER = `${STORE_FOLDER}/artwork-shards`
const REMEMBERED_KEY = 'jao.catalogueLocation'

export type CatalogueCandidate = {
  loc: MountpointRef
  /** A `.jotta-art-organizer` folder is here at all. */
  hasFolder: boolean
  /** Files under artwork-shards — where the tags actually live. This is the
   *  number that says whether a catalogue holds anything. */
  shards: number
  /** Their total size, as a second opinion on the same question: one shard
   *  holding two pictures and one holding two thousand both count as one. */
  bytes: number
  /** categories.json exists — the vocabulary: styles, subjects, the lot. */
  hasCategories: boolean
  /** A metadata.json from before the catalogue was split into shards. */
  hasLegacy: boolean
  /** The most recent change to anything in it. */
  changedAt?: number
  error?: string
}

/** Everything in this account that looks like a catalogue, most substantial
 *  first. One listing per mountpoint plus one for the shards, so it costs a
 *  couple of dozen requests at most. */
export async function findCatalogues(): Promise<CatalogueCandidate[]> {
  const mountpoints = await listMountpoints()
  const found: CatalogueCandidate[] = []

  for (const loc of mountpoints) {
    try {
      const root = await listFolder(loc, '')
      if (!root.folders.some((f) => f.name === STORE_FOLDER)) {
        found.push({ loc, hasFolder: false, shards: 0, bytes: 0, hasCategories: false, hasLegacy: false })
        continue
      }

      const store = await listFolder(loc, STORE_FOLDER).catch(() => null)
      const shardListing = store?.folders.some((f) => f.name === 'artwork-shards')
        ? await listFolder(loc, SHARDS_FOLDER).catch(() => null)
        : null
      const shardFiles = (shardListing?.files ?? []).filter((f) => f.name.endsWith('.json'))

      const times = [...(store?.files ?? []), ...shardFiles]
        .map((f) => jottaTime(f.modified) || jottaTime(f.created))
        .filter((t): t is number => Boolean(t))

      found.push({
        loc,
        hasFolder: true,
        shards: shardFiles.length,
        bytes: shardFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
        hasCategories: (store?.files ?? []).some((f) => f.name === 'categories.json'),
        hasLegacy: (store?.files ?? []).some((f) => f.name === 'metadata.json'),
        changedAt: times.length > 0 ? Math.max(...times) : undefined,
      })
    } catch (err) {
      found.push({
        loc,
        hasFolder: false,
        shards: 0,
        bytes: 0,
        hasCategories: false,
        hasLegacy: false,
        error: err instanceof Error ? err.message : 'Could not look in it.',
      })
    }
  }

  // Most substantial first: shard files, then their size. The one with the
  // tags in it is the one wanted, whatever it is called.
  return found.sort((a, b) => b.shards - a.shards || b.bytes - a.bytes)
}

/** Whether a candidate holds anything worth keeping. */
export function holdsCatalogue(c: CatalogueCandidate): boolean {
  return c.shards > 0 || c.hasLegacy
}

// Kept on the device beside the session so a reconnect restores it rather
// than asking again. Wrapped, because storage throws in a private window and
// an unavailable convenience must never stop the app loading.
export function rememberedLocation(): MountpointRef | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(REMEMBERED_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MountpointRef>
    if (!parsed.device || !parsed.mountpoint) return null
    return { device: parsed.device, mountpoint: parsed.mountpoint }
  } catch {
    return null
  }
}

export function rememberLocation(loc: MountpointRef): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint }))
  } catch {
    // Then it will be asked for again after a reconnect, which is where this
    // started — annoying, not harmful.
  }
}
