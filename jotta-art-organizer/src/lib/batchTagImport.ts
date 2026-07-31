// Checkpointed, resumable bulk import of Google Photos sidecar metadata as
// tags across an entire folder tree. Read-only with respect to the actual
// photo/video files — it only reads each sidecar JSON and writes to the tag
// metadata store, so there's no risk to originals and no per-file re-upload
// (unlike the single-photo "Fix embedded date/location" flow, which stays a
// manual one-at-a-time action).
//
// Folders are listed with `includeDeleted: true` and files are grouped by
// content hash (md5) before sidecar matching, so a sidecar that only pairs
// with a filename that was later soft-deleted as a "duplicate" (e.g. by a
// dedupe run that predates this feature) still gets matched and its tags
// attached to whichever copy of that content is still live. No restore is
// needed or attempted — Jottacloud's JFS API this app authenticates against
// doesn't expose an undelete endpoint (only a legacy, cookie-authenticated
// web endpoint that isn't part of this API and has been broken since 2016),
// but since tags are keyed by content hash rather than path, none is needed.
import { listFolder, type JottaEntry, type MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { findMetadataSidecar, loadMetadataSidecar, deriveTagsFromMetadata, hasImportableTags } from '@/lib/googlePhotosMetadata'
import { readArtworkMetadata, deriveTagsFromFileMetadata } from '@/lib/imageMetadata'
import { ensureCategoriesForTags, saveArtworkChanges, type MetadataStore, type ArtworkTags } from '@/lib/metadata'

export type BatchTagManifest = {
  device: string
  mountpoint: string
  rootPath: string
  queue: string[]
  visitedFolders: number
  processedFiles: number
  taggedCount: number
  skippedCount: number
  errorCount: number
  orphanedCount: number
  lastError: string | null
  status: 'in_progress' | 'complete'
  startedAt: string
  updatedAt: string
  /** Read each file's own properties as well as its sidecar. Costs a fetch
   *  per file, so it's opt-in; stored here so pause and resume keep it. */
  readFileProperties?: boolean
}

function batchFolderPath(batchId: string): string {
  return `.jotta-art-organizer/batch-tag-imports/${batchId}`
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

export async function loadBatchManifest(loc: MountpointRef, batchId: string): Promise<BatchTagManifest | null> {
  return readJsonFile<BatchTagManifest>(loc, `${batchFolderPath(batchId)}/${manifestFilename()}`)
}

async function saveBatchManifest(loc: MountpointRef, batchId: string, manifest: BatchTagManifest): Promise<void> {
  await writeJsonFile(loc, batchFolderPath(batchId), manifestFilename(), manifest)
}

export function newBatchManifest(
  loc: MountpointRef,
  rootPath: string,
  readFileProperties = false
): BatchTagManifest {
  const now = new Date().toISOString()
  return {
    device: loc.device,
    mountpoint: loc.mountpoint,
    rootPath,
    readFileProperties,
    queue: [rootPath],
    visitedFolders: 0,
    processedFiles: 0,
    taggedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    orphanedCount: 0,
    lastError: null,
    status: 'in_progress',
    startedAt: now,
    updatedAt: now,
  }
}

// A group of same-content (same md5) files within one folder — normally
// just the single live file, but can include names of soft-deleted
// duplicates too (via `listFolder(..., { includeDeleted: true })`). Trying
// every name in the group against the sidecar siblings means a Google
// Photos JSON that only pairs with a name that got deleted as a "duplicate"
// (before this app knew about sidecar tags) still gets found and attached
// to whichever copy of that content is still live — no restore needed,
// since tags are keyed by content hash, not by path.
type CandidateGroup = { liveEntry: JottaEntry; namesToTry: string[]; siblings: JottaEntry[] }

type FileResult = { entry: JottaEntry; tags: Record<string, string[]> | null; error?: string }

async function processGroup(
  loc: MountpointRef,
  group: CandidateGroup,
  existingTags: Record<string, string[]> | undefined,
  readFileProperties: boolean
): Promise<FileResult> {
  try {
    let derived = existingTags ?? {}
    let sawSidecar = false

    for (const name of group.namesToTry) {
      const sidecar = findMetadataSidecar(group.siblings, name)
      if (!sidecar) continue
      const metadata = await loadMetadataSidecar(loc, sidecar)
      if (!metadata || !hasImportableTags(metadata)) continue
      derived = deriveTagsFromMetadata(metadata, derived)
      sawSidecar = true
      break
    }

    // Without a sidecar the file is the only source, so it's always read.
    // With one, reading it as well costs a fetch per file — worth it when the
    // file carries what a sidecar never does (camera, GPS, content
    // credentials, an editor's own record), which is why it's a choice rather
    // than a default.
    if (!sawSidecar || readFileProperties) {
      const fileMetadata = await readArtworkMetadata(loc, group.liveEntry.path, {
        jottaCreated: group.liveEntry.created,
      })
      if (fileMetadata) derived = deriveTagsFromFileMetadata(fileMetadata, derived)
    }

    const changed = JSON.stringify(derived) !== JSON.stringify(existingTags ?? {})
    return { entry: group.liveEntry, tags: changed ? derived : null }
  } catch (err) {
    return { entry: group.liveEntry, tags: null, error: err instanceof Error ? err.message : 'Failed to read metadata.' }
  }
}

// Processes up to `folderChunkSize` folders from the front of the queue:
// lists them (bounded concurrency), reads any matching sidecar for each
// candidate file (bounded concurrency, pure reads so safely parallel), then
// folds the results into the tag store sequentially and checkpoints both
// the store and the manifest. Losing the tab right after this returns loses
// at most the *next* chunk — everything already folded in is saved.
export async function runBatchChunk(
  loc: MountpointRef,
  batchId: string,
  manifest: BatchTagManifest,
  store: MetadataStore,
  opts?: {
    folderChunkSize?: number
    folderConcurrency?: number
    fileConcurrency?: number
    onFile?: (path: string) => void
  }
): Promise<{ manifest: BatchTagManifest; store: MetadataStore }> {
  const folderChunkSize = opts?.folderChunkSize ?? 8
  const folderConcurrency = opts?.folderConcurrency ?? 4
  const fileConcurrency = opts?.fileConcurrency ?? 6

  const foldersToWalk = manifest.queue.slice(0, folderChunkSize)
  const remainingQueue = manifest.queue.slice(folderChunkSize)

  const discoveredFolders: string[] = []
  const candidates: CandidateGroup[] = []
  let orphanedCount = 0
  let filesSeen = 0

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
        // includeDeleted so a duplicate's original name (soft-deleted by a
        // past dedupe run) is still visible here — see CandidateGroup above.
        listFolder(loc, folderPath, { includeDeleted: true })
          .then((listing) => {
            const byMd5 = new Map<string, JottaEntry[]>()
            for (const f of listing.files) {
              if (f.md5 && !f.name.toLowerCase().endsWith('.json')) {
                const group = byMd5.get(f.md5) ?? []
                group.push(f)
                byMd5.set(f.md5, group)
              }
            }
            for (const group of byMd5.values()) {
              filesSeen += group.length
              const live = group.find((e) => !e.deleted)
              if (!live) {
                orphanedCount++
                continue
              }
              candidates.push({ liveEntry: live, namesToTry: group.map((e) => e.name), siblings: listing.files })
            }
            for (const sub of listing.folders) {
              if (!sub.deleted) discoveredFolders.push(sub.path)
            }
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

  const results: FileResult[] = []
  if (candidates.length > 0) {
    let cIdx = 0
    let cInFlight = 0
    await new Promise<void>((resolve) => {
      function pump() {
        while (cIdx < candidates.length && cInFlight < fileConcurrency) {
          const group = candidates[cIdx++]
          cInFlight++
          const existing = store.artworks.find((a) => a.md5 === group.liveEntry.md5)
          opts?.onFile?.(group.liveEntry.path)
          processGroup(loc, group, existing?.tags, manifest.readFileProperties === true)
            .then((result) => results.push(result))
            .finally(() => {
              cInFlight--
              pump()
              if (cIdx >= candidates.length && cInFlight === 0) resolve()
            })
        }
      }
      pump()
    })
  }

  let categories = store.categories
  let artworks = store.artworks
  let taggedCount = 0
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
      md5: entry.md5 as string,
      device: loc.device,
      mountpoint: loc.mountpoint,
      path: entry.path,
      lastSeenAt: now,
      tags,
    }
    artworks = [...withoutThis, record]
    changedRecords.push(record)
    taggedCount++
  }

  const nextStore: MetadataStore = { categories, artworks }
  const nextQueue = [...remainingQueue, ...discoveredFolders]
  const nextManifest: BatchTagManifest = {
    ...manifest,
    queue: nextQueue,
    visitedFolders: manifest.visitedFolders + foldersToWalk.length,
    processedFiles: manifest.processedFiles + filesSeen,
    taggedCount: manifest.taggedCount + taggedCount,
    skippedCount: manifest.skippedCount + skippedCount,
    errorCount: manifest.errorCount + errorCount,
    orphanedCount: (manifest.orphanedCount ?? 0) + orphanedCount,
    lastError,
    status: nextQueue.length === 0 ? 'complete' : 'in_progress',
    updatedAt: now,
  }

  // Only the categories file plus whichever shards this chunk's changed
  // records fall into get rewritten — not the whole tagged library.
  await saveArtworkChanges(loc, categories, { upsert: changedRecords })
  await saveBatchManifest(loc, batchId, nextManifest)

  return { manifest: nextManifest, store: nextStore }
}
