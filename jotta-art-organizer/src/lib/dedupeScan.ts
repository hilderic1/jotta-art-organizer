// Checkpointed, resumable exact-duplicate scanning for very large trees
// (tens/hundreds of thousands of files) where a single in-memory recursive
// walk isn't safe to rely on finishing in one browser session.
//
// Progress is stored in Jottacloud as a manifest + a sequence of small
// "batch" files (files discovered per processed chunk), rather than one
// giant snapshot rewritten on every checkpoint — at this scale a
// full-rewrite-per-checkpoint approach would mean re-uploading a growing
// multi-ten-MB blob over and over. Appending small batches means each
// checkpoint write stays small regardless of how far the scan has gotten.
import { listFolder, type MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'

export type ScanFileRecord = { path: string; md5: string; size: number }

export type ScanManifest = {
  device: string
  mountpoint: string
  rootPath: string
  queue: string[]
  visitedCount: number
  batchCount: number
  totalFilesSoFar: number
  status: 'in_progress' | 'complete'
  startedAt: string
  updatedAt: string
}

function scanFolderPath(scanId: string): string {
  return `.jotta-art-organizer/dedupe-scans/${scanId}`
}

function manifestFilename(): string {
  return 'manifest.json'
}

function batchFilename(batchIndex: number): string {
  return `batch-${String(batchIndex).padStart(5, '0')}.json`
}

export function scanIdFor(loc: MountpointRef, rootPath: string): string {
  const raw = `${loc.device}_${loc.mountpoint}_${rootPath}`
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return slug.slice(0, 120) || 'root'
}

export async function loadManifest(loc: MountpointRef, scanId: string): Promise<ScanManifest | null> {
  return readJsonFile<ScanManifest>(loc, `${scanFolderPath(scanId)}/${manifestFilename()}`)
}

async function saveManifest(loc: MountpointRef, scanId: string, manifest: ScanManifest): Promise<void> {
  await writeJsonFile(loc, scanFolderPath(scanId), manifestFilename(), manifest)
}

export function newManifest(loc: MountpointRef, rootPath: string): ScanManifest {
  const now = new Date().toISOString()
  return {
    device: loc.device,
    mountpoint: loc.mountpoint,
    rootPath,
    queue: [rootPath],
    visitedCount: 0,
    batchCount: 0,
    totalFilesSoFar: 0,
    status: 'in_progress',
    startedAt: now,
    updatedAt: now,
  }
}

// Processes up to `chunkSize` folders from the front of the queue (bounded
// concurrency), writes any newly-discovered files as one small batch file,
// and checkpoints the updated manifest. Losing the tab right after this
// returns loses at most the *next* chunk, never anything already processed.
export async function runScanChunk(
  loc: MountpointRef,
  scanId: string,
  manifest: ScanManifest,
  opts?: { chunkSize?: number; concurrency?: number; onFolder?: (path: string) => void }
): Promise<ScanManifest> {
  const chunkSize = opts?.chunkSize ?? 25
  const concurrency = opts?.concurrency ?? 4

  const toProcess = manifest.queue.slice(0, chunkSize)
  const remainingQueue = manifest.queue.slice(chunkSize)

  const discoveredFiles: ScanFileRecord[] = []
  const discoveredFolders: string[] = []

  let idx = 0
  let inFlight = 0
  let error: unknown = null

  await new Promise<void>((resolve) => {
    function pump() {
      if (error) {
        resolve()
        return
      }
      while (idx < toProcess.length && inFlight < concurrency) {
        const folderPath = toProcess[idx++]
        inFlight++
        listFolder(loc, folderPath)
          .then((listing) => {
            opts?.onFolder?.(folderPath)
            for (const f of listing.files) {
              if (f.md5) discoveredFiles.push({ path: f.path, md5: f.md5, size: f.size ?? 0 })
            }
            for (const sub of listing.folders) {
              discoveredFolders.push(sub.path)
            }
          })
          .catch((err) => {
            error = error ?? err
          })
          .finally(() => {
            inFlight--
            if (!error) pump()
            if (idx >= toProcess.length && inFlight === 0) resolve()
          })
      }
    }
    pump()
  })

  if (error) throw error

  const nextQueue = [...remainingQueue, ...discoveredFolders]
  const nextManifest: ScanManifest = {
    ...manifest,
    queue: nextQueue,
    visitedCount: manifest.visitedCount + toProcess.length,
    totalFilesSoFar: manifest.totalFilesSoFar + discoveredFiles.length,
    batchCount: manifest.batchCount + (discoveredFiles.length > 0 ? 1 : 0),
    status: nextQueue.length === 0 ? 'complete' : 'in_progress',
    updatedAt: new Date().toISOString(),
  }

  if (discoveredFiles.length > 0) {
    await writeJsonFile(loc, scanFolderPath(scanId), batchFilename(manifest.batchCount), discoveredFiles)
  }

  await saveManifest(loc, scanId, nextManifest)
  return nextManifest
}

export async function loadAllBatches(
  loc: MountpointRef,
  scanId: string,
  batchCount: number,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void }
): Promise<ScanFileRecord[]> {
  const concurrency = opts?.concurrency ?? 6
  const results: ScanFileRecord[][] = new Array(batchCount)
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
        readJsonFile<ScanFileRecord[]>(loc, `${scanFolderPath(scanId)}/${batchFilename(i)}`)
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
  return results.flat()
}
