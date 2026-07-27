// Checkpointed, resumable perceptual-hash (near-duplicate) scanning.
// Unlike the exact-duplicate folder walk, there's no traversal order to
// track — hashing is keyed purely by content (md5), so "what's left to do"
// is always just "representatives whose md5 isn't in the hash map yet."
// That makes resuming trivial and safe even if the underlying file list
// shifts slightly between runs (files added/removed just add/orphan
// entries, nothing breaks).
import { thumbnailUrl, type MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { computeDHash } from '@/lib/phash'

export type PhashManifest = {
  device: string
  mountpoint: string
  rootPath: string
  batchCount: number
  hashedCount: number
  startedAt: string
  updatedAt: string
}

type PhashPair = { md5: string; hash: string }

// Shares the same per-root folder as the exact-duplicate scan (dedupeScan.ts)
// — both are analyzing the same root, just at different granularity — with
// a distinct filename prefix so they don't collide.
function scanFolderPath(scanId: string): string {
  return `.jotta-art-organizer/dedupe-scans/${scanId}`
}

function manifestFilename(): string {
  return 'phash-manifest.json'
}

function batchFilename(batchIndex: number): string {
  return `phash-batch-${String(batchIndex).padStart(5, '0')}.json`
}

export async function loadPhashManifest(loc: MountpointRef, scanId: string): Promise<PhashManifest | null> {
  return readJsonFile<PhashManifest>(loc, `${scanFolderPath(scanId)}/${manifestFilename()}`)
}

async function savePhashManifest(loc: MountpointRef, scanId: string, manifest: PhashManifest): Promise<void> {
  await writeJsonFile(loc, scanFolderPath(scanId), manifestFilename(), manifest)
}

export function newPhashManifest(loc: MountpointRef, rootPath: string): PhashManifest {
  const now = new Date().toISOString()
  return {
    device: loc.device,
    mountpoint: loc.mountpoint,
    rootPath,
    batchCount: 0,
    hashedCount: 0,
    startedAt: now,
    updatedAt: now,
  }
}

export async function loadAllPhashes(
  loc: MountpointRef,
  scanId: string,
  batchCount: number,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void }
): Promise<Map<string, bigint>> {
  const concurrency = opts?.concurrency ?? 6
  const results: PhashPair[][] = new Array(batchCount)
  let idx = 0
  let inFlight = 0
  let done = 0
  let error: unknown = null

  await new Promise<void>((resolve) => {
    function pump() {
      if (error) {
        resolve()
        return
      }
      while (idx < batchCount && inFlight < concurrency) {
        const i = idx++
        inFlight++
        readJsonFile<PhashPair[]>(loc, `${scanFolderPath(scanId)}/${batchFilename(i)}`)
          .then((batch) => {
            results[i] = batch ?? []
          })
          .catch((err) => {
            error = error ?? err
          })
          .finally(() => {
            inFlight--
            done++
            opts?.onProgress?.(done, batchCount)
            if (!error) pump()
            if (idx >= batchCount && inFlight === 0) resolve()
          })
      }
    }
    pump()
  })

  if (error) throw error

  const map = new Map<string, bigint>()
  for (const batch of results) {
    for (const pair of batch) {
      map.set(pair.md5, BigInt(pair.hash))
    }
  }
  return map
}

// Hashes up to `chunkSize` targets (bounded concurrency), then checkpoints
// the results as one small batch file plus the updated manifest. Returns
// the newly-hashed pairs (caller merges them into its in-memory map) and
// the updated manifest.
export async function runPhashChunk(
  loc: MountpointRef,
  scanId: string,
  manifest: PhashManifest,
  targets: { md5: string; path: string }[],
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void }
): Promise<{ manifest: PhashManifest; hashed: Map<string, bigint> }> {
  const concurrency = opts?.concurrency ?? 5
  const hashed = new Map<string, bigint>()
  const toWrite: PhashPair[] = []

  let idx = 0
  let inFlight = 0
  let done = 0

  // Note: per-item failures (e.g. a non-image file that still had an md5)
  // are swallowed, not fatal — unlike the exact-duplicate folder walk,
  // one bad image shouldn't abort the whole chunk.
  await new Promise<void>((resolve) => {
    function pump() {
      while (idx < targets.length && inFlight < concurrency) {
        const target = targets[idx++]
        inFlight++
        computeDHash(thumbnailUrl(loc, target.path))
          .then((hash) => {
            hashed.set(target.md5, hash)
            toWrite.push({ md5: target.md5, hash: hash.toString() })
          })
          .catch(() => {})
          .finally(() => {
            inFlight--
            done++
            opts?.onProgress?.(done, targets.length)
            pump()
            if (idx >= targets.length && inFlight === 0) resolve()
          })
      }
    }
    pump()
  })

  const nextManifest: PhashManifest = {
    ...manifest,
    batchCount: manifest.batchCount + (toWrite.length > 0 ? 1 : 0),
    hashedCount: manifest.hashedCount + toWrite.length,
    updatedAt: new Date().toISOString(),
  }

  if (toWrite.length > 0) {
    await writeJsonFile(loc, scanFolderPath(scanId), batchFilename(manifest.batchCount), toWrite)
  }
  await savePhashManifest(loc, scanId, nextManifest)

  return { manifest: nextManifest, hashed }
}
