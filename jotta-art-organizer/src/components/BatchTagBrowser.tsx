'use client'

import { useEffect, useRef, useState } from 'react'
import { listFolder, listMountpoints, type MountpointRef, type JottaFolderListing } from '@/lib/api'
import {
  batchIdFor,
  loadBatchManifest,
  newBatchManifest,
  runBatchChunk,
  type BatchTagManifest,
} from '@/lib/batchTagImport'
import type { MetadataStore } from '@/lib/metadata'

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function BatchTagBrowser({
  store,
  onStoreUpdated,
  initialLocation,
}: {
  store: MetadataStore
  onStoreUpdated: (next: MetadataStore) => void
  initialLocation?: (MountpointRef & { path?: string }) | null
}) {
  // Seeded from the folder already chosen on the Tags page, so this view
  // doesn't ask for a location a second time.
  const [location, setLocation] = useState<MountpointRef | null>(
    initialLocation ? { device: initialLocation.device, mountpoint: initialLocation.mountpoint } : null
  )
  const [mountpoints, setMountpoints] = useState<MountpointRef[] | null>(null)
  const [mountpointsError, setMountpointsError] = useState<string | null>(null)
  const [path, setPath] = useState(initialLocation?.path ?? '')
  const [listing, setListing] = useState<JottaFolderListing | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)

  const [manifest, setManifest] = useState<BatchTagManifest | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const stopRef = useRef(false)

  useEffect(() => {
    if (location !== null) return
    let ignore = false
    listMountpoints()
      .then((mps) => {
        if (!ignore) setMountpoints(mps)
      })
      .catch((err) => {
        if (!ignore) setMountpointsError(err instanceof Error ? err.message : 'Failed to list Jottacloud devices.')
      })
    return () => {
      ignore = true
    }
  }, [location])

  useEffect(() => {
    if (location === null) return
    let ignore = false
    listFolder(location, path)
      .then((data) => {
        if (!ignore) {
          setListing(data)
          setListingError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setListingError(err instanceof Error ? err.message : 'Failed to load folder.')
      })
    return () => {
      ignore = true
    }
  }, [location, path])

  const scanKey = location ? `${location.device}/${location.mountpoint}/${path}` : null

  // Check for a previous (possibly incomplete) batch import of this exact
  // root whenever the folder changes — only sets state inside .then()/.catch(),
  // same pattern used by the dedupe scans.
  useEffect(() => {
    if (!location) return
    let ignore = false
    const batchId = batchIdFor(location, path)
    loadBatchManifest(location, batchId)
      .then((m) => {
        if (ignore) return
        setManifest(m)
        setLoadedKey(scanKey)
        setManifestError(null)
      })
      .catch((err) => {
        if (!ignore) setManifestError(err instanceof Error ? err.message : 'Failed to check for a previous run.')
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scanKey is derived from location/path, already covered
  }, [location, path])

  const checkingManifest = scanKey !== null && scanKey !== loadedKey && !manifestError

  async function runLoop(startManifest: BatchTagManifest, batchId: string) {
    if (!location) return
    setRunning(true)
    setRunError(null)
    stopRef.current = false
    let currentManifest = startManifest
    let currentStore = store
    try {
      while (currentManifest.status === 'in_progress' && !stopRef.current) {
        const result = await runBatchChunk(location, batchId, currentManifest, currentStore, {
          onFile: (p) => setCurrentFile(p),
        })
        currentManifest = result.manifest
        currentStore = result.store
        setManifest(currentManifest)
        onStoreUpdated(currentStore)
      }
    } catch (err) {
      setRunError(
        err instanceof Error
          ? `${err.message} — progress up to the last checkpoint is saved; you can resume.`
          : 'Tagging failed — progress up to the last checkpoint is saved; you can resume.'
      )
    } finally {
      setRunning(false)
      setCurrentFile(null)
    }
  }

  function startFresh() {
    if (!location) return
    const batchId = batchIdFor(location, path)
    const fresh = newBatchManifest(location, path)
    setManifest(fresh)
    runLoop(fresh, batchId)
  }

  function resume() {
    if (!manifest || !location) return
    const batchId = batchIdFor(location, path)
    runLoop(manifest, batchId)
  }

  function pause() {
    stopRef.current = true
  }

  const crumbs = segments(path)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Reads every file in this folder and its subfolders, and tags each one from whatever it already carries —
        the same as pressing &ldquo;Use as tags&rdquo; on each by hand. Nothing is written to the files themselves.
        Safe to pause and resume at any point.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>
          <span className="font-medium">Google Photos sidecars</span> — a matching{' '}
          <code className="text-xs">supplemental-metadata.json</code> gives People, Favorited, Year, Date Created
          and Source.
        </li>
        <li>
          <span className="font-medium">Dates from the file</span> — Photo Taken Time, Date Acquired and File
          changed, read from EXIF and IPTC. Where a file records none, the date it reached Jottacloud is used
          instead, kept as its own tag so it&rsquo;s never mistaken for when the work was made.
        </li>
        <li>
          <span className="font-medium">Editor history</span> — artwork exported from Picsart carries the date of
          the session that made it, how long it was drawn for, and whether a photo was used.
        </li>
        <li>
          <span className="font-medium">Content credentials</span> — files signed with C2PA declare how they were
          made, giving Source type (AI-generated, AI-assisted) and Credit.
        </li>
        <li>
          <span className="font-medium">File properties</span> — dimensions, resolution, program name, authors and
          copyright.
        </li>
      </ul>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Also checks recently soft-deleted duplicates: if a sidecar only matches a filename that a past dedupe run
        removed as a duplicate, its tags are still attached to whichever identical copy is still here — nothing
        needs restoring.
      </p>

      {location === null ? (
        <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
            Choose a location
          </div>
          <div className="min-h-[120px] p-3">
            {mountpointsError && <p className="text-sm text-red-600 dark:text-red-400">{mountpointsError}</p>}
            {!mountpointsError && mountpoints === null && <p className="text-sm text-zinc-500">Loading…</p>}
            {mountpoints && mountpoints.length > 0 && (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {mountpoints.map((mp) => (
                  <li key={`${mp.device}/${mp.mountpoint}`}>
                    <button
                      className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                      onClick={() => {
                        setLocation(mp)
                        setPath('')
                        setListing(null)
                      }}
                    >
                      🗂 {mp.mountpoint} <span className="text-xs text-zinc-400">— {mp.device}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
            <button
              className="text-zinc-500 hover:underline"
              onClick={() => {
                setLocation(null)
                setMountpoints(null)
                setListing(null)
              }}
            >
              « Locations
            </button>
            <span className="text-zinc-400">/</span>
            <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setPath('')}>
              {location.mountpoint}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-zinc-400">/</span>
                <button
                  className="text-indigo-600 hover:underline dark:text-indigo-400"
                  onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
                >
                  {c}
                </button>
              </span>
            ))}
          </div>

          {listingError && <p className="text-sm text-red-600 dark:text-red-400">{listingError}</p>}

          {listing && listing.folders.length > 0 && (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
              {listing.folders.map((f) => (
                <li key={f.path}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                    onClick={() => setPath([...crumbs, f.name].join('/'))}
                  >
                    📁 {f.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-800">
            {checkingManifest && <p className="text-xs text-zinc-500">Checking for a previous run…</p>}
            {manifestError && <p className="text-xs text-red-600 dark:text-red-400">{manifestError}</p>}

            {!checkingManifest && !manifestError && (
              <>
                {manifest === null && !running && (
                  <button
                    onClick={startFresh}
                    className="w-fit rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                  >
                    Tag this folder + subfolders
                  </button>
                )}

                {manifest && manifest.status === 'in_progress' && !running && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-zinc-500">
                      Previous run in progress: {manifest.visitedFolders} folders done,{' '}
                      {manifest.queue.length} queued, {manifest.processedFiles} files checked,{' '}
                      {manifest.taggedCount} tagged so far.
                    </span>
                    <button
                      onClick={resume}
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      Resume tagging
                    </button>
                    <button
                      onClick={startFresh}
                      className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Discard &amp; start fresh
                    </button>
                  </div>
                )}

                {running && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-zinc-500 truncate">
                      Tagging… {manifest?.visitedFolders ?? 0} folders done, {manifest?.queue.length ?? 0} queued,{' '}
                      {manifest?.processedFiles ?? 0} files checked, {manifest?.taggedCount ?? 0} tagged
                      {currentFile ? ` — ${currentFile}` : ''}
                    </span>
                    <button
                      onClick={pause}
                      className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Pause
                    </button>
                  </div>
                )}

                {runError && <p className="text-xs text-red-600 dark:text-red-400">{runError}</p>}
                {manifest && manifest.errorCount > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {manifest.errorCount} file{manifest.errorCount === 1 ? '' : 's'} failed to read
                    {manifest.lastError ? ` (last error: ${manifest.lastError})` : ''} — everything else still
                    proceeded.
                  </p>
                )}

                {manifest && manifest.status === 'complete' && !running && (
                  <p className="text-sm text-zinc-500">
                    Done: {manifest.processedFiles} files checked across {manifest.visitedFolders} folders —{' '}
                    {manifest.taggedCount} tagged, {manifest.skippedCount} skipped (no metadata or nothing new)
                    {manifest.errorCount > 0 ? `, ${manifest.errorCount} errors` : ''}
                    {manifest.orphanedCount > 0
                      ? `, ${manifest.orphanedCount} duplicate group${manifest.orphanedCount === 1 ? '' : 's'} fully deleted (no live copy left to tag)`
                      : ''}
                    .
                    <button onClick={startFresh} className="ml-2 text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                      Re-run from scratch
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
