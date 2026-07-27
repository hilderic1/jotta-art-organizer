// Checkpointed, resumable AI vision classification (style/subject/palette/
// framed/mood) across a folder tree. Unlike every other batch tool in this
// app, each file here costs real money (a paid Anthropic API call per
// image), so concurrency is kept low and already-classified files are
// skipped by default — re-running a batch shouldn't re-spend on unchanged
// content.
import { listFolder, type MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { classifyArtwork, tagsFromClassification, isFullyClassified } from '@/lib/visionClassify'
import { ensureCategoriesForTags, saveArtworkChanges, type MetadataStore, type ArtworkTags } from '@/lib/metadata'

type PendingFile = { path: string; md5: string }

export type BatchVisionManifest = {
  device: string
  mountpoint: string
  rootPath: string
  queue: string[]
  // Candidates already discovered but not yet classified — carried over
  // whenever a chunk finds more work than its `maxFilesPerChunk` cap, so a
  // folder with hundreds of images doesn't force one giant chunk. Optional
  // for backward compatibility with manifests saved before this existed.
  pendingFiles?: PendingFile[]
  visitedFolders: number
  processedFiles: number
  classifiedCount: number
  skippedCount: number
  errorCount: number
  lastError: string | null
  status: 'in_progress' | 'complete'
  startedAt: string
  updatedAt: string
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function batchFolderPath(batchId: string): string {
  return `.jotta-art-organizer/batch-vision-classify/${batchId}`
}

function manifestFilename(): string {
  return 'manifest.json'
}

export function batchIdFor(loc: MountpointRef, rootPath: string): string {
  const raw = `${loc.device}_${loc.mountpoint}_${rootPath}`
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return slug.slice(0, 120) || 'root'
}

export async function loadBatchManifest(loc: MountpointRef, batchId: string): Promise<BatchVisionManifest | null> {
  return readJsonFile<BatchVisionManifest>(loc, `${batchFolderPath(batchId)}/${manifestFilename()}`)
}

async function saveBatchManifest(loc: MountpointRef, batchId: string, manifest: BatchVisionManifest): Promise<void> {
  await writeJsonFile(loc, batchFolderPath(batchId), manifestFilename(), manifest)
}

export function newBatchManifest(loc: MountpointRef, rootPath: string): BatchVisionManifest {
  const now = new Date().toISOString()
  return {
    device: loc.device,
    mountpoint: loc.mountpoint,
    rootPath,
    queue: [rootPath],
    pendingFiles: [],
    visitedFolders: 0,
    processedFiles: 0,
    classifiedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    lastError: null,
    status: 'in_progress',
    startedAt: now,
    updatedAt: now,
  }
}

type FileResult = { entry: PendingFile; tags: Record<string, string[]> | null; error?: string }

// One retry on a 429 (rate limited) after a short pause; any other failure
// is swallowed as a per-file error, same as the other batch tools — one bad
// image shouldn't abort the whole chunk.
async function classifyWithRetry(loc: MountpointRef, path: string): Promise<Record<string, string[]> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await classifyArtwork(loc, path)
      return tagsFromClassification(result)
    } catch (err) {
      const isRateLimited = err instanceof Error && err.message.toLowerCase().includes('rate limited')
      if (isRateLimited && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      throw err
    }
  }
  return null
}

async function processFile(
  loc: MountpointRef,
  entry: PendingFile,
  existingTags: Record<string, string[]> | undefined
): Promise<FileResult> {
  if (isFullyClassified(existingTags)) return { entry, tags: null }
  try {
    const tags = await classifyWithRetry(loc, entry.path)
    return { entry, tags: tags ? { ...existingTags, ...tags } : null }
  } catch (err) {
    return { entry, tags: null, error: err instanceof Error ? err.message : 'Classification failed.' }
  }
}

// Processes at most `maxFilesPerChunk` candidate files (classifying with low
// bounded concurrency — this hits a paid, rate-limited API — nowhere near
// the concurrency the free batch tools use), then checkpoints the store and
// manifest. Discovering a folder's contents is cheap and always finishes in
// full, but *classifying* what's inside can be slow (several seconds per
// image), so that part is capped per chunk — otherwise a folder with
// hundreds of images turned into one giant chunk that Pause couldn't
// interrupt for minutes. Leftover discovered-but-unclassified files are
// carried over via `manifest.pendingFiles` rather than being reprocessed
// from a folder listing next time.
export async function runBatchChunk(
  loc: MountpointRef,
  batchId: string,
  manifest: BatchVisionManifest,
  store: MetadataStore,
  opts?: {
    folderChunkSize?: number
    folderConcurrency?: number
    fileConcurrency?: number
    maxFilesPerChunk?: number
    onFile?: (path: string) => void
  }
): Promise<{ manifest: BatchVisionManifest; store: MetadataStore }> {
  const folderChunkSize = opts?.folderChunkSize ?? 3
  const folderConcurrency = opts?.folderConcurrency ?? 3
  const fileConcurrency = opts?.fileConcurrency ?? 2
  const maxFilesPerChunk = opts?.maxFilesPerChunk ?? 12

  const carriedOver = manifest.pendingFiles ?? []
  let foldersToWalk: string[] = []
  let remainingQueue = manifest.queue
  const discoveredFolders: string[] = []
  const candidates: PendingFile[] = carriedOver

  // Only discover more work if we don't already have a backlog — keeps a
  // chunk's folder-listing cost bounded too, and avoids growing the pending
  // list unboundedly ahead of what we can actually classify this chunk.
  if (carriedOver.length === 0) {
    foldersToWalk = manifest.queue.slice(0, folderChunkSize)
    remainingQueue = manifest.queue.slice(folderChunkSize)

    let fIdx = 0
    let fInFlight = 0
    let listError: unknown = null
    await new Promise<void>((resolve) => {
      function pump() {
        if (listError) {
          resolve()
          return
        }
        while (fIdx < foldersToWalk.length && fInFlight < folderConcurrency) {
          const folderPath = foldersToWalk[fIdx++]
          fInFlight++
          listFolder(loc, folderPath)
            .then((listing) => {
              for (const f of listing.files) {
                if (f.md5 && isImageFile(f.name)) candidates.push({ path: f.path, md5: f.md5 })
              }
              for (const sub of listing.folders) discoveredFolders.push(sub.path)
            })
            .catch((err) => {
              listError = listError ?? err
            })
            .finally(() => {
              fInFlight--
              if (!listError) pump()
              if (fIdx >= foldersToWalk.length && fInFlight === 0) resolve()
            })
        }
      }
      pump()
    })
    if (listError) throw listError
  }

  const toProcess = candidates.slice(0, maxFilesPerChunk)
  const leftover = candidates.slice(maxFilesPerChunk)

  const results: FileResult[] = []
  if (toProcess.length > 0) {
    let cIdx = 0
    let cInFlight = 0
    await new Promise<void>((resolve) => {
      function pump() {
        while (cIdx < toProcess.length && cInFlight < fileConcurrency) {
          const entry = toProcess[cIdx++]
          cInFlight++
          const existing = store.artworks.find((a) => a.md5 === entry.md5)
          opts?.onFile?.(entry.path)
          processFile(loc, entry, existing?.tags)
            .then((result) => results.push(result))
            .finally(() => {
              cInFlight--
              pump()
              if (cIdx >= toProcess.length && cInFlight === 0) resolve()
            })
        }
      }
      pump()
    })
  }

  let categories = store.categories
  let artworks = store.artworks
  let classifiedCount = 0
  let skippedCount = 0
  let errorCount = 0
  let lastError = manifest.lastError
  const now = new Date().toISOString()
  const changedRecords: ArtworkTags[] = []

  for (const { entry, tags, error } of results) {
    if (error) {
      errorCount++
      lastError = error
      continue
    }
    if (!tags) {
      skippedCount++
      continue
    }
    categories = ensureCategoriesForTags(categories, tags)
    const withoutThis = artworks.filter((a) => a.md5 !== entry.md5)
    const record: ArtworkTags = {
      md5: entry.md5,
      device: loc.device,
      mountpoint: loc.mountpoint,
      path: entry.path,
      lastSeenAt: now,
      tags,
    }
    artworks = [...withoutThis, record]
    changedRecords.push(record)
    classifiedCount++
  }

  const nextStore: MetadataStore = { categories, artworks }
  const nextQueue = [...remainingQueue, ...discoveredFolders]
  const nextManifest: BatchVisionManifest = {
    ...manifest,
    queue: nextQueue,
    pendingFiles: leftover,
    visitedFolders: manifest.visitedFolders + foldersToWalk.length,
    processedFiles: manifest.processedFiles + toProcess.length,
    classifiedCount: manifest.classifiedCount + classifiedCount,
    skippedCount: manifest.skippedCount + skippedCount,
    errorCount: manifest.errorCount + errorCount,
    lastError,
    status: nextQueue.length === 0 && leftover.length === 0 ? 'complete' : 'in_progress',
    updatedAt: now,
  }

  // Only the categories file plus whichever shards this chunk's changed
  // records fall into get rewritten — not the whole tagged library.
  await saveArtworkChanges(loc, categories, { upsert: changedRecords })
  await saveBatchManifest(loc, batchId, nextManifest)

  return { manifest: nextManifest, store: nextStore }
}
