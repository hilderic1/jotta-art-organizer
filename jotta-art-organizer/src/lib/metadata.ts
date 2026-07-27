import type { MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { KNOWN_CLASSIFICATION_VALUES } from '@/lib/visionClassify'

export type Category = {
  id: string
  name: string
  values: string[]
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
  authors: 'Authors',
  programName: 'Program Name',
  copyright: 'Copyright',
  style: 'Style',
  subject: 'Subject',
  palette: 'Palette',
  framed: 'Framed',
  mood: 'Mood',
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
      // Subject, Palette, Framed, Mood) — seed it in full on first use so
      // every surface (this editor, Categories, Browse by tag) shows the
      // complete picker immediately instead of only whichever values have
      // happened to be assigned so far.
      next = [
        ...next,
        { id: categoryId, name: KNOWN_CATEGORY_NAMES[categoryId] ?? categoryId, values: [...(KNOWN_CLASSIFICATION_VALUES[categoryId] ?? [])] },
      ]
      idx = next.length - 1
    }
    const missing = values.filter((v) => !next[idx].values.includes(v))
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
  const keys = await loadShardIndex(loc)
  if (keys.length === 0) return []
  const concurrency = opts?.concurrency ?? 8
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
  return results.flat()
}

export async function loadMetadata(loc: MountpointRef): Promise<MetadataStore> {
  const categoriesFile = await readJsonFile<{ categories: Category[] }>(loc, `${METADATA_FOLDER}/${CATEGORIES_FILENAME}`)
  if (categoriesFile) {
    const artworks = await loadAllArtworkShards(loc)
    return { categories: categoriesFile.categories ?? [], artworks }
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
