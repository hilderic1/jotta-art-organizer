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
import {
  listMountpoints,
  listAccountDevices,
  listFolder,
  jottaTime,
  type MountpointRef,
} from '@/lib/api'
import { loadMetadata } from '@/lib/metadata'

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

export type CatalogueSearch = {
  candidates: CatalogueCandidate[]
  /** Devices the account names whose listing couldn't be read, so whose
   *  folders — and any catalogue in them — were never looked at. A missing
   *  tag that is nowhere to be found is explained by one of these long
   *  before it is explained by the tag never existing. */
  skippedDevices: { device: string; reason: string }[]
}

/** Everything in this account that looks like a catalogue, most substantial
 *  first. One listing per mountpoint plus one for the shards, so it costs a
 *  couple of dozen requests at most. */
export async function searchForCatalogues(): Promise<CatalogueSearch> {
  const { mountpoints, skipped } = await listAccountDevices()
  return { candidates: await weigh(mountpoints), skippedDevices: skipped }
}

/** The list alone, for callers that only need somewhere to read from. */
export async function findCatalogues(): Promise<CatalogueCandidate[]> {
  return weigh(await listMountpoints())
}

async function weigh(mountpoints: MountpointRef[]): Promise<CatalogueCandidate[]> {
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

export type TagSighting = {
  loc: MountpointRef
  md5: string
  path: string
  /** What it says about the picture, so a found record can be recognised as
   *  the right one rather than merely counted. */
  tags: Record<string, string[]>
}

/**
 * Looks for a picture's tags in every catalogue in the account, by filename.
 *
 * When a name has gone missing, "the catalogue has 258 files in it" answers
 * nothing: the question is where that one record is, and whether it exists at
 * all. Records are keyed by content hash, but they carry the path they were
 * last seen at, and that is a name a person can search for.
 */
export async function findTagsForName(
  name: string,
  candidates: CatalogueCandidate[]
): Promise<TagSighting[]> {
  const needle = name.trim().toLowerCase()
  if (!needle) return []
  const sightings: TagSighting[] = []

  for (const candidate of candidates) {
    if (!holdsCatalogue(candidate)) continue
    const store = await loadMetadata(candidate.loc).catch(() => null)
    if (!store) continue
    for (const artwork of store.artworks) {
      const leaf = (artwork.path ?? '').split('/').pop()?.toLowerCase() ?? ''
      if (leaf === needle || leaf.includes(needle)) {
        sightings.push({
          loc: candidate.loc,
          md5: artwork.md5,
          path: artwork.path ?? '',
          tags: artwork.tags,
        })
      }
    }
  }

  return sightings
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

/**
 * Works out where the catalogue is without asking, where that can be done.
 *
 * This app is opened from an iPad, an Android phone and a laptop, and the
 * session it runs in is per device — so remembering the answer on one device
 * does nothing for the next, which gets asked afresh and can answer wrongly
 * afresh. The account is the only place the answer is actually true of, and
 * it can be read from there: a catalogue is a folder with tag files in it.
 *
 * Asked only when the account is genuinely ambiguous — no catalogue anywhere,
 * or more than one — because those are the cases where a person knows
 * something the files don't say.
 */
export async function resolveCatalogueLocation(): Promise<
  { loc: MountpointRef; how: 'remembered' | 'found' } | { loc: null; candidates: CatalogueCandidate[] }
> {
  const remembered = rememberedLocation()
  if (remembered) return { loc: remembered, how: 'remembered' }

  const candidates = await findCatalogues()
  const real = candidates.filter(holdsCatalogue)
  // Exactly one: there is nothing to choose between, so choosing is noise.
  if (real.length === 1) {
    rememberLocation(real[0].loc)
    return { loc: real[0].loc, how: 'found' }
  }
  return { loc: null, candidates }
}

export function rememberLocation(loc: MountpointRef): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint }))
  } catch {
    // Then it will be asked for again after a reconnect, which is where this
    // started — annoying, not harmful.
  }
}
