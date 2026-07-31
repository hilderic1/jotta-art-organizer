// Caches tag shards on the device so a repeat visit doesn't refetch them.
//
// Shards are keyed by the first two hex characters of a file's content hash,
// and hashes are uniform, so any folder past a few hundred files touches
// essentially all 256 of them. Fetching "only the shards this folder needs"
// therefore saves nothing at that size — every load meant a few hundred round
// trips from a phone.
//
// The shards folder listing carries a `modified` timestamp per shard, so one
// listing request is enough to decide what actually changed. Unchanged shards
// come from IndexedDB; a visit with nothing changed costs that one request.
import type { ArtworkTags } from '@/lib/metadata'

const DB_NAME = 'jotta-art-organizer'
const STORE = 'shards'
const DB_VERSION = 1

export type CachedShard = { records: ArtworkTags[]; modified: string }

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
      }
      request.onsuccess = () => resolve(request.result)
      // A blocked or unavailable database is not worth failing a page load
      // over — every caller falls back to fetching, which always works.
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

// Keyed by account location as well as shard: two Jottacloud accounts, or two
// metadata folders, must never see each other's records.
function keyFor(scope: string, shardKey: string): string {
  return `${scope}::${shardKey}`
}

export async function readCachedShards(
  scope: string,
  shardKeys: string[]
): Promise<Map<string, CachedShard>> {
  const found = new Map<string, CachedShard>()
  const db = await open()
  if (!db) return found

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    let pending = shardKeys.length
    if (pending === 0) resolve()
    for (const shardKey of shardKeys) {
      const request = store.get(keyFor(scope, shardKey))
      request.onsuccess = () => {
        const value = request.result as CachedShard | undefined
        if (value && Array.isArray(value.records)) found.set(shardKey, value)
        if (--pending === 0) resolve()
      }
      request.onerror = () => {
        if (--pending === 0) resolve()
      }
    }
    tx.onerror = () => resolve()
  })

  db.close()
  return found
}

export async function writeCachedShards(
  scope: string,
  entries: { shardKey: string; records: ArtworkTags[]; modified: string }[]
): Promise<void> {
  if (entries.length === 0) return
  const db = await open()
  if (!db) return

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const entry of entries) {
      store.put({ records: entry.records, modified: entry.modified }, keyFor(scope, entry.shardKey))
    }
    tx.oncomplete = () => resolve()
    // A failed write costs a refetch next time, nothing more.
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })

  db.close()
}
