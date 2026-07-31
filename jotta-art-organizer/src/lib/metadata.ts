import { listFolder, type MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { KNOWN_CLASSIFICATION_VALUES } from '@/lib/visionClassify'
import { readCachedShards, writeCachedShards } from '@/lib/shardCache'

export type Category = {
  id: string
  name: string
  values: string[]
  /** Per-file prose (a title, a note) rather than a shared vocabulary. Values
   *  aren't collected into `values`: every one would be unique, which would
   *  turn the picker and the Browse filters into a list of one-off entries
   *  that group nothing. */
  freeText?: boolean
}

export type ArtworkTags = {
  md5: string
  device: string
  mountpoint: string
  path: string
  lastSeenAt: string
  tags: Record<string, string[]>
}

export type MetadataStore = {
  categories: Category[]
  artworks: ArtworkTags[]
}

// Display names for category ids that can get auto-created by imported tags
// (e.g. from Google Photos metadata) before the user has ever defined them
// manually in the Categories tab.
export const KNOWN_CATEGORY_NAMES: Record<string, string> = {
  people: 'People',
  favorited: 'Favorited',
  year: 'Year',
  photoTakenTime: 'Photo Taken Time',
  creationTime: 'Creation Time',
  geoData: 'Geo Data',
  source: 'Source',
  dimensions: 'Dimensions',
  xResolution: 'Horizontal Resolution',
  yResolution: 'Vertical Resolution',
  dateAcquired: 'Date Acquired',
  camera: 'Camera',
  jottaCreated: 'Added to Jottacloud',
  fileChanged: 'File changed',
  editorCreated: 'Created in editor',
  sourceType: 'Source type',
  credit: 'Credit',
  photoUsed: 'Photo used',
  drawTime: 'Time drawing',
  authors: 'Authors',
  programName: 'Program Name',
  copyright: 'Copyright',
  style: 'Style',
  subject: 'Subject',
  framed: 'Framed',
  figures: 'Figures',
  // Points an AI-enhanced piece back at the original it came from. The
  // enhanced file's own credentials name the tool that made it and claim it
  // as generated; nothing in it records whose work it started from.
  derivedFrom: 'Enhanced from',
}

// Auto-registers any category/value referenced in `tags` that doesn't exist
// yet, rather than silently dropping tags with no matching category. Shared
// between the interactive tag editor and the batch importer so both stay
// consistent about what "using a tag" means.
export function ensureCategoriesForTags(categories: Category[], tags: Record<string, string[]>): Category[] {
  let next = categories
  for (const [categoryId, values] of Object.entries(tags)) {
    let idx = next.findIndex((c) => c.id === categoryId)
    if (idx === -1) {
      // AI-classification categories have a known closed list (Style,
      // Subject, Framed) — seed it in full on first use so
      // every surface (this editor, Categories, Browse by tag) shows the
      // complete picker immediately instead of only whichever values have
      // happened to be assigned so far.
      next = [
        ...next,
        { id: categoryId, name: KNOWN_CATEGORY_NAMES[categoryId] ?? categoryId, values: [...(KNOWN_CLASSIFICATION_VALUES[categoryId] ?? [])] },
      ]
      idx = next.length - 1
    }
    // Free-text categories keep an empty vocabulary on purpose: collecting
    // one-off titles or notes would fill the pickers and Browse filters with
    // entries that match a single file each.
    if (next[idx].freeText) continue

    // Top up the closed list even when the category already exists. Without
    // this, a category created under an older vocabulary only ever gains the
    // values that happen to get assigned, so the picker stays half-empty and
    // the new options look missing until something is tagged with each one.
    const canonical = KNOWN_CLASSIFICATION_VALUES[categoryId] ?? []
    const missing = [...new Set([...canonical, ...values])].filter((v) => !next[idx].values.includes(v))
    if (missing.length > 0) {
      next = next.map((c, i) => (i === idx ? { ...c, values: [...c.values, ...missing] } : c))
    }
  }
  return next
}

const METADATA_FOLDER = '.jotta-art-organizer'

// Legacy (pre-sharding) single-file store — read-only now, kept only so
// existing tag data migrates in automatically on first load. Never written
// to or deleted by the current code, so it stays a safety net regardless
// of what happens with the sharded format below.
const LEGACY_METADATA_PATH = `${METADATA_FOLDER}/metadata.json`

// Current format: a small categories file plus many small artwork "shards"
// keyed by the first two hex characters of each photo's content hash (up to
// 256 shards). Editing one photo's tags now touches only the one shard it
// belongs to, instead of rewriting every tagged file's record — which is
// what made saving slow once the library passed tens of thousands of
// tagged files. `categories.json` is small regardless of library size, so
// it's always rewritten on save; its existence doubles as the signal that
// an account has migrated to this format (see loadMetadata).
const CATEGORIES_FILENAME = 'categories.json'
const ARTWORK_SHARDS_FOLDER = `${METADATA_FOLDER}/artwork-shards`
const SHARD_INDEX_FILENAME = '_index.json'

function shardKeyFor(md5: string): string {
  if (typeof md5 !== 'string' || md5.length < 2) return 'xx'
  return md5.slice(0, 2).toLowerCase()
}

function shardFilename(shardKey: string): string {
  return `${shardKey}.json`
}

function emptyStore(): MetadataStore {
  return { categories: [], artworks: [] }
}

// Style, Subject and Framed are closed vocabularies, so a
// value outside the canonical list is invalid by definition — a leftover
// from an older vocabulary, or the nested arrays a briefly-wrong
// classification wrote (which render as "Calm/Serene,Dreamy/Mystical", one
// bogus entry per combination). Cleaning them out on read matters more than
// it looks: saving re-registers whatever values a record carries, so junk
// left on artworks reappears in the category list however often it's
// deleted by hand.
function cleanTagValues(categoryId: string, values: unknown): string[] {
  const strings = (Array.isArray(values) ? values : []).filter((v): v is string => typeof v === 'string')
  const canonical = KNOWN_CLASSIFICATION_VALUES[categoryId]
  return canonical ? strings.filter((v) => canonical.includes(v)) : strings
}

// Facts about one file rather than qualities shared between files. As tags
// they produced a value per picture, which groups nothing and buries the
// categories that do — so they're shown in the properties panel instead, and
// dropped here so earlier runs don't leave them behind.
// Palette, Mood, Motion and Suggested style are retired for a different
// reason: they asked a machine to have an opinion about someone's own work.
// Style, Subject, Framed and Figures describe what is there; the rest read
// as a verdict on it, which is not a thing to hand to a classifier.
const RETIRED_CATEGORY_IDS = new Set([
  'dimensions',
  'xResolution',
  'yResolution',
  'camera',
  'authors',
  'palette',
  'mood',
  'motion',
  'suggestedStyle',
])

// Dates worth having, and dates worth having only in the absence of one.
// When a piece was digitised, when Google received it, and when it reached
// Jottacloud say little about when it was made — a bulk upload gives
// hundreds of files the same value — so they're kept only as a last resort,
// leaving every file with exactly one date to sort by.
const PREFERRED_DATE_IDS = ['photoTakenTime', 'editorCreated', 'fileChanged']
const FALLBACK_DATE_IDS = ['dateAcquired', 'creationTime', 'jottaCreated']

function cleanArtwork(artwork: ArtworkTags): ArtworkTags {
  const tags: Record<string, string[]> = {}
  for (const [categoryId, values] of Object.entries(artwork.tags ?? {})) {
    if (RETIRED_CATEGORY_IDS.has(categoryId)) continue
    const cleaned = cleanTagValues(categoryId, values)
    if (cleaned.length > 0) tags[categoryId] = cleaned
  }

  if (PREFERRED_DATE_IDS.some((id) => (tags[id]?.length ?? 0) > 0)) {
    for (const id of FALLBACK_DATE_IDS) delete tags[id]
  } else {
    // Keep only the best fallback, so a file never carries three dates that
    // all mean "we don't know when this was made".
    const kept = FALLBACK_DATE_IDS.find((id) => (tags[id]?.length ?? 0) > 0)
    for (const id of FALLBACK_DATE_IDS) if (id !== kept) delete tags[id]
  }

  return { ...artwork, tags }
}

// Closed-list categories are reset to exactly their canonical values, which
// drops junk and fills gaps in one pass. Open categories (People, Year, the
// style suggestions) keep whatever they hold, minus non-strings.
function cleanCategories(categories: Category[]): Category[] {
  return categories
    .filter((category) => !RETIRED_CATEGORY_IDS.has(category.id))
    .map((category) => {
    const canonical = KNOWN_CLASSIFICATION_VALUES[category.id]
    // Switching a category to free text empties its vocabulary — the values
    // collected while it was a picker are one-off entries by then, and the
    // per-file tags themselves are untouched.
    if (category.freeText) return { ...category, values: [] }
    return {
      ...category,
      values: canonical
        ? [...canonical]
        : (category.values ?? []).filter((v): v is string => typeof v === 'string'),
    }
  })
}

async function loadShardIndex(loc: MountpointRef): Promise<string[]> {
  return (await readJsonFile<string[]>(loc, `${ARTWORK_SHARDS_FOLDER}/${SHARD_INDEX_FILENAME}`)) ?? []
}

async function saveShardIndex(loc: MountpointRef, keys: string[]): Promise<void> {
  await writeJsonFile(loc, ARTWORK_SHARDS_FOLDER, SHARD_INDEX_FILENAME, keys)
}

async function loadShard(loc: MountpointRef, shardKey: string): Promise<ArtworkTags[]> {
  return (await readJsonFile<ArtworkTags[]>(loc, `${ARTWORK_SHARDS_FOLDER}/${shardFilename(shardKey)}`)) ?? []
}

async function saveShard(loc: MountpointRef, shardKey: string, records: ArtworkTags[]): Promise<void> {
  await writeJsonFile(loc, ARTWORK_SHARDS_FOLDER, shardFilename(shardKey), records)
}

// Only fetches shards actually listed in the index (not all 256 possible
// prefixes), with bounded concurrency — this happens once per page load
// rather than on every edit, so it's fine for it to cost more than a single
// request the old single-file design didn't need.
async function loadAllArtworkShards(loc: MountpointRef, opts?: { concurrency?: number }): Promise<ArtworkTags[]> {
  return loadShardsCached(loc, await loadShardIndex(loc))
}

// One folder listing decides what actually changed. Shards whose timestamp
// matches the cached copy are read from the device; only the rest are
// fetched. A revisit with nothing changed costs that single listing, instead
// of the few hundred round trips this used to take from a phone.
async function loadShardsCached(loc: MountpointRef, keys: string[]): Promise<ArtworkTags[]> {
  if (keys.length === 0) return []

  const listing = await listFolder(loc, ARTWORK_SHARDS_FOLDER).catch(() => null)
  if (!listing) return loadShardsByKeys(loc, keys)

  const modifiedByKey = new Map<string, string>()
  for (const file of listing.files) {
    const key = file.name.replace(/\.json$/i, '')
    const stamp = file.modified ?? file.created
    if (stamp) modifiedByKey.set(key, stamp)
  }

  const scope = `${loc.device}/${loc.mountpoint}`
  const cached = await readCachedShards(scope, keys)

  const fresh: ArtworkTags[] = []
  const stale: string[] = []
  for (const key of keys) {
    const hit = cached.get(key)
    const current = modifiedByKey.get(key)
    // No timestamp means the listing didn't mention it — refetch rather than
    // trust a cached copy of something we can't date.
    if (hit && current && hit.modified === current) fresh.push(...hit.records)
    else stale.push(key)
  }

  if (stale.length === 0) return fresh

  const fetched = await loadShardsWithKeys(loc, stale)
  await writeCachedShards(
    scope,
    stale
      .map((key) => ({ shardKey: key, records: fetched.get(key) ?? [], modified: modifiedByKey.get(key) ?? '' }))
      .filter((entry) => entry.modified !== '')
  )

  return [...fresh, ...[...fetched.values()].flat()]
}

async function loadShardsByKeys(
  loc: MountpointRef,
  keys: string[],
  opts?: { concurrency?: number }
): Promise<ArtworkTags[]> {
  return [...(await loadShardsWithKeys(loc, keys, opts)).values()].flat()
}

// Returns each shard's records against its key, so the caller can cache them
// individually rather than as one indivisible blob.
async function loadShardsWithKeys(
  loc: MountpointRef,
  keys: string[],
  opts?: { concurrency?: number }
): Promise<Map<string, ArtworkTags[]>> {
  if (keys.length === 0) return new Map()
  const concurrency = opts?.concurrency ?? 16
  const results: ArtworkTags[][] = new Array(keys.length)
  let idx = 0
  let inFlight = 0
  let error: unknown = null
  await new Promise<void>((resolve) => {
    function pump() {
      if (error) {
        resolve()
        return
      }
      while (idx < keys.length && inFlight < concurrency) {
        const i = idx++
        inFlight++
        loadShard(loc, keys[i])
          .then((r) => {
            results[i] = r
          })
          .catch((err) => {
            error = error ?? err
          })
          .finally(() => {
            inFlight--
            if (!error) pump()
            if (idx >= keys.length && inFlight === 0) resolve()
          })
      }
    }
    pump()
  })
  if (error) throw error
  return new Map(keys.map((key, i) => [key, results[i] ?? []]))
}

export async function loadMetadata(loc: MountpointRef): Promise<MetadataStore> {
  const categoriesFile = await readJsonFile<{ categories: Category[] }>(loc, `${METADATA_FOLDER}/${CATEGORIES_FILENAME}`)
  if (categoriesFile) {
    const artworks = await loadAllArtworkShards(loc)
    return { categories: cleanCategories(categoriesFile.categories ?? []), artworks: artworks.map(cleanArtwork) }
  }
  // Not migrated to the sharded format yet (or a brand-new account) — fall
  // back to the old single-file store, then immediately write everything
  // out into shards. This has to happen in full right now: if we returned
  // the legacy data as-is and left migration to "whatever gets saved
  // next," the next save would only write the one record it actually
  // changed, and then writing categories.json would make loadMetadata
  // think migration was complete — silently orphaning every other
  // pre-existing record, which never got copied into a shard.
  const legacy = await readJsonFile<MetadataStore>(loc, LEGACY_METADATA_PATH)
  if (!legacy) return emptyStore()
  const categories = legacy.categories ?? []
  const artworks = legacy.artworks ?? []
  await migrateToShardedFormat(loc, categories, artworks)
  return { categories, artworks }
}

// Reading every shard costs one request per shard — a few hundred on a large
// library — but the Tags page only ever needs the records for the one folder
// being worked on. Listing that folder is cheap when it's small, and its
// files' md5s say exactly which shards could hold their records, usually a
// handful. A big tree would cost more to list than it saves, so the walk
// gives up early and the caller falls back to reading every shard.
const FOLDER_SCAN_BUDGET = 12
const FILE_SCAN_BUDGET = 8000

async function collectFolderMd5s(folder: MountpointRef & { path?: string }): Promise<Set<string> | null> {
  const md5s = new Set<string>()
  const queue: string[] = [folder.path?.trim() || '']
  let visited = 0

  while (queue.length > 0) {
    const batch = queue.splice(0, 4)
    const listings = await Promise.all(batch.map((p) => listFolder(folder, p)))
    for (const listing of listings) {
      visited++
      for (const file of listing.files) {
        if (file.md5) md5s.add(file.md5)
      }
      for (const sub of listing.folders) queue.push(sub.path)
    }
    if (visited + queue.length > FOLDER_SCAN_BUDGET) return null
    if (md5s.size > FILE_SCAN_BUDGET) return null
  }
  return md5s
}

export type FolderMetadata = {
  store: MetadataStore
  shardsLoaded: number
  shardsTotal: number
  targeted: boolean
}

function isInFolder(record: ArtworkTags, folder: MountpointRef & { path?: string }): boolean {
  if (record.device !== folder.device || record.mountpoint !== folder.mountpoint) return false
  const path = folder.path?.trim()
  if (!path) return true
  return record.path === path || record.path.startsWith(`${path}/`)
}

// Tag data for one folder. The returned artworks are only that folder's, but
// categories are always complete — saving rewrites categories.json wholesale,
// so handing back a trimmed list would delete the rest on the next save.
export async function loadMetadataForFolder(
  metadataLoc: MountpointRef,
  folder: MountpointRef & { path?: string }
): Promise<FolderMetadata> {
  const categoriesFile = await readJsonFile<{ categories: Category[] }>(
    metadataLoc,
    `${METADATA_FOLDER}/${CATEGORIES_FILENAME}`
  )
  // A store that hasn't been migrated yet still has to go through the full
  // read-and-migrate path — see loadMetadata for why that can't be deferred.
  if (!categoriesFile) {
    const full = await loadMetadata(metadataLoc)
    return {
      store: { categories: full.categories, artworks: full.artworks.filter((a) => isInFolder(a, folder)) },
      shardsLoaded: 0,
      shardsTotal: 0,
      targeted: false,
    }
  }

  const index = await loadShardIndex(metadataLoc)
  // A failed listing (permissions, a folder deleted mid-flight) is not worth
  // failing the whole page over — fall back to reading everything.
  const md5s = await collectFolderMd5s(folder).catch(() => null)

  let keys = index
  if (md5s) {
    const wanted = new Set([...md5s].map(shardKeyFor))
    keys = index.filter((k) => wanted.has(k))
  }

  const artworks = await loadShardsCached(metadataLoc, keys)
  return {
    store: {
      categories: cleanCategories(categoriesFile.categories ?? []),
      artworks: artworks.filter((a) => isInFolder(a, folder)).map(cleanArtwork),
    },
    shardsLoaded: keys.length,
    shardsTotal: index.length,
    targeted: md5s !== null,
  }
}

// Writes every existing record into its shard, then writes categories.json
// last — its existence is what loadMetadata treats as "migration done," so
// if this gets interrupted partway through (network failure, tab closed),
// the next load safely retries the whole migration from the untouched
// legacy blob instead of presenting a half-populated shard set as current.
async function migrateToShardedFormat(loc: MountpointRef, categories: Category[], artworks: ArtworkTags[]): Promise<void> {
  const byShardKey = new Map<string, ArtworkTags[]>()
  for (const record of artworks) {
    const key = shardKeyFor(record.md5)
    const list = byShardKey.get(key) ?? []
    list.push(record)
    byShardKey.set(key, list)
  }
  const keys = [...byShardKey.keys()]

  if (keys.length > 0) {
    let idx = 0
    let inFlight = 0
    const concurrency = 6
    let error: unknown = null
    await new Promise<void>((resolve) => {
      function pump() {
        if (error) {
          resolve()
          return
        }
        while (idx < keys.length && inFlight < concurrency) {
          const key = keys[idx++]
          inFlight++
          saveShard(loc, key, byShardKey.get(key)!)
            .catch((err) => {
              error = error ?? err
            })
            .finally(() => {
              inFlight--
              if (!error) pump()
              if (idx >= keys.length && inFlight === 0) resolve()
            })
        }
      }
      pump()
    })
    if (error) throw error
  }

  await saveShardIndex(loc, keys.sort())
  await writeJsonFile(loc, METADATA_FOLDER, CATEGORIES_FILENAME, { categories })
}

// Persists a categories update and/or specific artwork record changes —
// callers pass only what actually changed, not the whole store, so a
// single-photo edit costs one small shard write instead of rewriting every
// tagged file.
export async function saveArtworkChanges(
  loc: MountpointRef,
  categories: Category[],
  changes?: { upsert?: ArtworkTags[]; remove?: string[] }
): Promise<void> {
  await writeJsonFile(loc, METADATA_FOLDER, CATEGORIES_FILENAME, { categories })

  const upsert = changes?.upsert ?? []
  const remove = changes?.remove ?? []
  if (upsert.length === 0 && remove.length === 0) return

  const byShardKey = new Map<string, { upsert: ArtworkTags[]; remove: Set<string> }>()
  function entryFor(key: string) {
    let e = byShardKey.get(key)
    if (!e) {
      e = { upsert: [], remove: new Set<string>() }
      byShardKey.set(key, e)
    }
    return e
  }
  for (const record of upsert) entryFor(shardKeyFor(record.md5)).upsert.push(record)
  for (const md5 of remove) entryFor(shardKeyFor(md5)).remove.add(md5)

  const index = new Set(await loadShardIndex(loc))
  let indexChanged = false
  const keys = [...byShardKey.keys()]

  let idx = 0
  let inFlight = 0
  const concurrency = 6
  let error: unknown = null
  await new Promise<void>((resolve) => {
    function pump() {
      if (error) {
        resolve()
        return
      }
      while (idx < keys.length && inFlight < concurrency) {
        const key = keys[idx++]
        inFlight++
        ;(async () => {
          const { upsert: toUpsert, remove: toRemove } = byShardKey.get(key)!
          const existing = await loadShard(loc, key)
          const upsertMd5s = new Set(toUpsert.map((r) => r.md5))
          const merged = [...existing.filter((r) => !upsertMd5s.has(r.md5) && !toRemove.has(r.md5)), ...toUpsert]
          await saveShard(loc, key, merged)
          if (!index.has(key)) {
            index.add(key)
            indexChanged = true
          }
        })()
          .catch((err) => {
            error = error ?? err
          })
          .finally(() => {
            inFlight--
            if (!error) pump()
            if (idx >= keys.length && inFlight === 0) resolve()
          })
      }
    }
    pump()
  })
  if (error) throw error

  if (indexChanged) await saveShardIndex(loc, [...index].sort())
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
