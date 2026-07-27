'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Thumbnail } from '@/components/Thumbnail'
import { ImageViewer } from '@/components/ImageViewer'
import {
  getSessionStatus,
  listMountpoints,
  listFolder,
  deleteFile,
  viewUrl,
  type SessionStatus,
  type MountpointRef,
  type JottaFolderListing,
  type JottaEntry,
} from '@/lib/api'
import { clusterBySimilarity } from '@/lib/phash'
import {
  scanIdFor,
  loadManifest,
  newManifest,
  runScanChunk,
  loadAllBatches,
  type ScanManifest,
} from '@/lib/dedupeScan'
import {
  loadPhashManifest,
  newPhashManifest,
  runPhashChunk,
  loadAllPhashes,
  type PhashManifest,
} from '@/lib/phashScan'

function uniqueByMd5(files: JottaEntry[]): JottaEntry[] {
  const seen = new Set<string>()
  const result: JottaEntry[] = []
  for (const f of files) {
    if (!f.md5 || seen.has(f.md5)) continue
    // Skip metadata sidecars and JSON files — they can't be perceptually hashed
    if (f.path.endsWith('.json') || f.path.endsWith('.supplemental-metadata.json')) continue
    seen.add(f.md5)
    result.push(f)
  }
  return result
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

type DuplicateGroup = { md5: string; entries: JottaEntry[] }

export default function DedupePage() {
  const [session, setSession] = useState<SessionStatus | null>(null)

  const [location, setLocation] = useState<MountpointRef | null>(null)
  const [mountpoints, setMountpoints] = useState<MountpointRef[] | null>(null)
  const [mountpointsError, setMountpointsError] = useState<string | null>(null)

  const [path, setPath] = useState('')
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [listing, setListing] = useState<JottaFolderListing | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)

  const [toDelete, setToDelete] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number; currentName: string } | null>(
    null
  )

  // Recursive scanning is checkpointed (manifest + small batch files saved
  // to Jottacloud as it goes) rather than a single in-memory walk, since a
  // large tree (many thousands of files) can't be relied on to finish
  // scanning in one uninterrupted browser session.
  const [recursive, setRecursive] = useState(false)
  const [scanManifest, setScanManifest] = useState<ScanManifest | null>(null)
  const [loadedScanKey, setLoadedScanKey] = useState<string | null>(null)
  const [scanManifestError, setScanManifestError] = useState<string | null>(null)
  const [scanRunning, setScanRunning] = useState(false)
  const [scanCurrentFolder, setScanCurrentFolder] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const scanStopRef = useRef(false)

  const [recursiveFiles, setRecursiveFiles] = useState<JottaEntry[] | null>(null)
  const [loadingResults, setLoadingResults] = useState(false)
  const [loadResultsProgress, setLoadResultsProgress] = useState<{ done: number; total: number } | null>(null)
  const [loadResultsError, setLoadResultsError] = useState<string | null>(null)

  const [viewingImage, setViewingImage] = useState<{ loc: MountpointRef; path: string } | null>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

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
          setResultMessage(null)
        }
      })
      .catch((err) => {
        if (!ignore) setListingError(err instanceof Error ? err.message : 'Failed to load folder.')
      })
    return () => {
      ignore = true
    }
  }, [location, path, refreshIndex])

  // In recursive mode, this includes every file under the current folder,
  // not just the ones directly in it — loaded on demand from a checkpointed
  // scan's batch files since it can mean many more requests than a
  // single-folder listing.
  const effectiveFiles: JottaEntry[] = useMemo(
    () => (recursive && recursiveFiles ? recursiveFiles : (listing?.files ?? [])),
    [recursive, recursiveFiles, listing]
  )

  const scanKey = recursive && location ? `${location.device}/${location.mountpoint}/${path}` : null
  const listingKey = location ? `${location.device}/${location.mountpoint}/${path}` : null

  // Check for a previous (possibly incomplete) scan of this exact root
  // whenever recursive mode is turned on or the root changes. Only sets
  // state inside the .then()/.catch() callbacks, never synchronously in the
  // effect body — the accepted pattern used elsewhere in this file.
  useEffect(() => {
    if (!recursive || !location) return
    let ignore = false
    const scanId = scanIdFor(location, path)
    loadManifest(location, scanId)
      .then((m) => {
        if (ignore) return
        setScanManifest(m)
        setLoadedScanKey(scanKey)
        setScanManifestError(null)
      })
      .catch((err) => {
        if (!ignore) setScanManifestError(err instanceof Error ? err.message : 'Failed to check for an existing scan.')
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scanKey is derived from location/path, already covered
  }, [recursive, location, path])

  const checkingManifest = scanKey !== null && scanKey !== loadedScanKey && !scanManifestError

  async function runScanLoop(startManifest: ScanManifest, scanId: string) {
    if (!location) return
    setScanRunning(true)
    setScanError(null)
    scanStopRef.current = false
    let manifest = startManifest
    try {
      while (manifest.status === 'in_progress' && !scanStopRef.current) {
        manifest = await runScanChunk(location, scanId, manifest, {
          onFolder: (p) => setScanCurrentFolder(p),
        })
        setScanManifest(manifest)
      }
    } catch (err) {
      setScanError(
        err instanceof Error
          ? `${err.message} — progress up to the last checkpoint is saved; you can resume.`
          : 'Scan failed — progress up to the last checkpoint is saved; you can resume.'
      )
    } finally {
      setScanRunning(false)
      setScanCurrentFolder(null)
    }
  }

  function startFreshScan() {
    if (!location) return
    const scanId = scanIdFor(location, path)
    const manifest = newManifest(location, path)
    setScanManifest(manifest)
    setRecursiveFiles(null)
    setLoadResultsError(null)
    runScanLoop(manifest, scanId)
  }

  function resumeScan() {
    if (!scanManifest || !location) return
    const scanId = scanIdFor(location, path)
    runScanLoop(scanManifest, scanId)
  }

  function pauseScan() {
    scanStopRef.current = true
  }

  async function loadScanResults() {
    if (!location || !scanManifest) return
    setLoadingResults(true)
    setLoadResultsError(null)
    try {
      const scanId = scanIdFor(location, path)
      const records = await loadAllBatches(location, scanId, scanManifest.batchCount, {
        onProgress: (done, total) => setLoadResultsProgress({ done, total }),
      })
      const asEntries: JottaEntry[] = records.map((r) => ({
        name: r.path.split('/').pop() ?? r.path,
        path: r.path,
        isFolder: false,
        md5: r.md5,
        size: r.size,
      }))
      setRecursiveFiles(asEntries)
    } catch (err) {
      setLoadResultsError(err instanceof Error ? err.message : 'Failed to load scan results.')
    } finally {
      setLoadingResults(false)
      setLoadResultsProgress(null)
    }
  }

  const duplicateGroups: DuplicateGroup[] = useMemo(() => {
    const byMd5 = new Map<string, JottaEntry[]>()
    for (const f of effectiveFiles) {
      if (!f.md5) continue
      const group = byMd5.get(f.md5) ?? []
      group.push(f)
      byMd5.set(f.md5, group)
    }
    return [...byMd5.entries()].filter(([, entries]) => entries.length > 1).map(([md5, entries]) => ({ md5, entries }))
  }, [effectiveFiles])

  // Default selection: keep the first file in each group, mark the rest for
  // removal. Recomputed during render (not in an Effect) whenever the set of
  // duplicate groups actually changes — React's documented pattern for
  // state that should reset when derived data changes.
  const groupsKey = duplicateGroups.map((g) => g.md5).join('|')
  const [toDeleteGroupsKey, setToDeleteGroupsKey] = useState<string | null>(null)
  const [visibleDupCount, setVisibleDupCount] = useState(20)
  if (groupsKey !== toDeleteGroupsKey) {
    setToDeleteGroupsKey(groupsKey)
    const next = new Set<string>()
    for (const group of duplicateGroups) {
      for (const entry of group.entries.slice(1)) {
        next.add(entry.path)
      }
    }
    setToDelete(next)
    setVisibleDupCount(20)
  }

  // Similar (not identical) images — perceptual-hash based, approximate.
  // Checkpointed the same way as the exact-duplicate scan above, but keyed
  // purely by content hash rather than traversal order: "what's left to do"
  // is always just "representatives not in the hash map yet," which makes
  // pausing/resuming trivial regardless of chunk boundaries.
  const [similarThreshold, setSimilarThreshold] = useState(10)
  const [phashManifest, setPhashManifest] = useState<PhashManifest | null>(null)
  const [loadedPhashKey, setLoadedPhashKey] = useState<string | null>(null)
  const [phashManifestError, setPhashManifestError] = useState<string | null>(null)
  const [phashMap, setPhashMap] = useState<Map<string, bigint> | null>(null)
  const [phashRunning, setPhashRunning] = useState(false)
  const [phashProgress, setPhashProgress] = useState<{ done: number; total: number } | null>(null)
  const [phashError, setPhashError] = useState<string | null>(null)
  const phashStopRef = useRef(false)
  const phashInitialTotalRef = useRef<number | null>(null)

  const [similarSelected, setSimilarSelected] = useState<Set<string>>(new Set())
  const [similarRemoving, setSimilarRemoving] = useState(false)
  const [similarRemoveError, setSimilarRemoveError] = useState<string | null>(null)
  const [similarResultMessage, setSimilarResultMessage] = useState<string | null>(null)
  const [similarRemoveProgress, setSimilarRemoveProgress] = useState<{ done: number; total: number } | null>(null)

  // Reset the similarity scan whenever the folder being viewed changes —
  // same render-time-reset pattern as toDeleteGroupsKey above.
  const [similarListingKey, setSimilarListingKey] = useState<string | null>(null)
  const [visibleSimilarCount, setVisibleSimilarCount] = useState(20)
  if (listingKey !== similarListingKey) {
    setSimilarListingKey(listingKey)
    setSimilarSelected(new Set())
    setSimilarResultMessage(null)
    setRecursiveFiles(null)
    setLoadResultsError(null)
    setVisibleSimilarCount(20)
    phashInitialTotalRef.current = null
  }

  // Check for (and eagerly load) a previous phash scan of this folder
  // whenever the root changes — regardless of recursive mode, since hashing
  // thousands of images is slow even within a single folder.
  useEffect(() => {
    if (!location) return
    let ignore = false
    const scanId = scanIdFor(location, path)
    loadPhashManifest(location, scanId)
      .then(async (m) => {
        if (ignore) return
        setPhashManifest(m)
        if (m && m.batchCount > 0) {
          const map = await loadAllPhashes(location, scanId, m.batchCount)
          if (!ignore) setPhashMap(map)
        } else if (!ignore) {
          setPhashMap(new Map())
        }
        if (!ignore) {
          setLoadedPhashKey(listingKey)
          setPhashManifestError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setPhashManifestError(err instanceof Error ? err.message : 'Failed to check for an existing scan.')
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listingKey is derived from location/path, already covered
  }, [location, path])

  const checkingPhashManifest = location !== null && listingKey !== loadedPhashKey && !phashManifestError

  const phashRepresentatives = useMemo(() => uniqueByMd5(effectiveFiles), [effectiveFiles])
  const phashRemainingCount = phashMap
    ? phashRepresentatives.filter((f) => f.md5 && !phashMap.has(f.md5)).length
    : phashRepresentatives.length

  const similarGroups: JottaEntry[][] = useMemo(() => {
    if (!phashMap) return []
    const items = phashRepresentatives
      .filter((f) => f.md5 && phashMap.has(f.md5))
      .map((entry) => ({ item: entry, hash: phashMap.get(entry.md5 as string) as bigint }))
    return clusterBySimilarity(items, similarThreshold)
  }, [phashMap, phashRepresentatives, similarThreshold])

  async function runPhashLoop(startManifest: PhashManifest, scanId: string, startMap: Map<string, bigint>) {
    if (!location) return
    setPhashRunning(true)
    setPhashError(null)
    phashStopRef.current = false

    // Capture representatives ONCE at start — prevent re-renders from changing the file list mid-scan
    const capturedRepresentatives = phashRepresentatives
    const initialTotal = capturedRepresentatives.filter((f) => f.md5).length
    phashInitialTotalRef.current = null // Reset for next scan

    let manifest = startManifest
    const map = new Map(startMap)
    try {
      while (!phashStopRef.current && manifest.hashedCount < initialTotal) {
        const remaining = capturedRepresentatives.filter((f) => f.md5 && !map.has(f.md5))
        if (remaining.length === 0) break
        const chunk = remaining.slice(0, 30).map((f) => ({ md5: f.md5 as string, path: f.path }))
        const result = await runPhashChunk(location, scanId, manifest, chunk)
        manifest = result.manifest
        for (const [k, v] of result.hashed) map.set(k, v)
        // Update UI with progress
        setPhashProgress({ done: manifest.hashedCount, total: initialTotal })
        setPhashManifest(manifest)
        setPhashMap(new Map(map))
      }
    } catch (err) {
      setPhashError(
        err instanceof Error
          ? `${err.message} — progress saved; you can resume.`
          : 'Scan failed — progress saved; you can resume.'
      )
    } finally {
      // Ensure cleanup always happens
      setPhashRunning(false)
      setPhashProgress(null)
      phashInitialTotalRef.current = null
    }
  }

  function startOrResumePhashScan() {
    if (!location) return
    const scanId = scanIdFor(location, path)
    const manifest = phashManifest ?? newPhashManifest(location, path)
    if (!phashManifest) {
      setPhashManifest(manifest)
    }
    // Always reset the initial total when starting a scan (fresh or resume)
    phashInitialTotalRef.current = null
    runPhashLoop(manifest, scanId, phashMap ?? new Map())
  }

  function pausePhashScan() {
    phashStopRef.current = true
  }

  function resetPhashScan() {
    setPhashManifest(null)
    setPhashMap(new Map())
    phashInitialTotalRef.current = null
  }

  function toggleSimilar(path: string) {
    setSimilarSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function handleRemoveSimilar() {
    if (!location || similarSelected.size === 0) return
    setSimilarRemoving(true)
    setSimilarRemoveError(null)
    setSimilarResultMessage(null)
    const targets = [...similarSelected]
    let removed = 0
    try {
      for (const filePath of targets) {
        setSimilarRemoveProgress({ done: removed, total: targets.length })
        await deleteFile(location, filePath)
        removed++
      }
      setSimilarResultMessage(`Removed ${removed} file${removed === 1 ? '' : 's'} (moved to Jottacloud trash).`)
      setRefreshIndex((i) => i + 1)
    } catch (err) {
      setSimilarRemoveError(
        `Removed ${removed} of ${targets.length} before failing: ${err instanceof Error ? err.message : 'Unknown error.'}`
      )
    } finally {
      setSimilarRemoveProgress(null)
      setSimilarRemoving(false)
    }
  }

  function toggle(path: string) {
    setToDelete((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function handleRemove() {
    if (!location || toDelete.size === 0) return
    setDeleting(true)
    setDeleteError(null)
    setResultMessage(null)
    const targets = [...toDelete]
    let removed = 0
    try {
      for (const filePath of targets) {
        setDeleteProgress({ done: removed, total: targets.length, currentName: filePath.split('/').pop() ?? filePath })
        await deleteFile(location, filePath)
        removed++
      }
      setResultMessage(`Removed ${removed} duplicate${removed === 1 ? '' : 's'} (moved to Jottacloud trash).`)
      setRefreshIndex((i) => i + 1)
    } catch (err) {
      setDeleteError(
        `Removed ${removed} of ${targets.length} before failing: ${err instanceof Error ? err.message : 'Unknown error.'}`
      )
    } finally {
      setDeleteProgress(null)
      setDeleting(false)
    }
  }

  if (session === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  if (!session.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your Jottacloud account first.</p>
        <Link href="/setup" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  const crumbs = segments(path)
  const bytesToFree = duplicateGroups
    .flatMap((g) => g.entries)
    .filter((e) => toDelete.has(e.path))
    .reduce((sum, e) => sum + (e.size ?? 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Remove duplicates</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Scans a folder already in Jottacloud for files with identical content and removes the extras (moved to
          Jottacloud&rsquo;s trash, not permanently deleted).
        </p>
      </div>

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

          {listing && (
            <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => {
                    setRecursive(e.target.checked)
                    if (!e.target.checked) setRecursiveFiles(null)
                  }}
                />
                Include subfolders (recursive, checkpointed — safe for very large trees)
              </label>

              {recursive && (
                <>
                  {checkingManifest && <p className="text-xs text-zinc-500">Checking for a previous scan…</p>}
                  {scanManifestError && <p className="text-xs text-red-600 dark:text-red-400">{scanManifestError}</p>}

                  {!checkingManifest && !scanManifestError && (
                    <>
                      {scanManifest === null && !scanRunning && (
                        <button
                          onClick={startFreshScan}
                          className="w-fit rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                        >
                          Scan this folder + subfolders
                        </button>
                      )}

                      {scanManifest && scanManifest.status === 'in_progress' && !scanRunning && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-zinc-500">
                            Previous scan in progress: {scanManifest.visitedCount} folders done,{' '}
                            {scanManifest.queue.length} queued, {scanManifest.totalFilesSoFar} files found so far.
                          </span>
                          <button
                            onClick={resumeScan}
                            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                          >
                            Resume scan
                          </button>
                          <button
                            onClick={startFreshScan}
                            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          >
                            Discard &amp; start fresh
                          </button>
                        </div>
                      )}

                      {scanRunning && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-zinc-500 truncate">
                            Scanning… {scanManifest?.visitedCount ?? 0} folders done, {scanManifest?.queue.length ?? 0}{' '}
                            queued, {scanManifest?.totalFilesSoFar ?? 0} files found
                            {scanCurrentFolder ? ` — ${scanCurrentFolder}` : ''}
                          </span>
                          <button
                            onClick={pauseScan}
                            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          >
                            Pause
                          </button>
                        </div>
                      )}

                      {scanError && <p className="text-xs text-red-600 dark:text-red-400">{scanError}</p>}

                      {scanManifest && scanManifest.status === 'complete' && !scanRunning && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-zinc-500">
                            Scan complete: {scanManifest.totalFilesSoFar} files found across {scanManifest.visitedCount}{' '}
                            folders.
                          </span>
                          <button
                            disabled={loadingResults}
                            onClick={loadScanResults}
                            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {loadingResults ? 'Loading…' : recursiveFiles ? 'Reload results' : 'Load results'}
                          </button>
                          <button onClick={startFreshScan} className="text-xs text-zinc-500 hover:underline">
                            Re-scan from scratch
                          </button>
                        </div>
                      )}

                      {loadingResults && loadResultsProgress && (
                        <p className="text-xs text-zinc-500">
                          Loading batch {loadResultsProgress.done}/{loadResultsProgress.total}…
                        </p>
                      )}
                      {loadResultsError && <p className="text-xs text-red-600 dark:text-red-400">{loadResultsError}</p>}
                      {recursiveFiles && (
                        <p className="text-xs text-zinc-500">{recursiveFiles.length} files loaded for duplicate analysis.</p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {listing && listing.folders.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Subfolders</h2>
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
            </div>
          )}

          {listing && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
                {effectiveFiles.length} file{effectiveFiles.length === 1 ? '' : 's'}
                {recursive && recursiveFiles ? ' (including subfolders)' : ' in this folder'}
                {duplicateGroups.length > 0 &&
                  ` — ${duplicateGroups.length} duplicate group${duplicateGroups.length === 1 ? '' : 's'} found`}
              </h2>

              {duplicateGroups.length === 0 && (
                <p className="text-sm text-zinc-500">No duplicate content found in this folder.</p>
              )}

              {duplicateGroups.slice(0, visibleDupCount).map((group) => (
                <div key={group.md5} className="mb-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <p className="mb-2 text-xs text-zinc-500">
                    {group.entries.length} copies · {formatBytes(group.entries[0].size ?? 0)} each
                  </p>
                  <ul className="flex flex-col gap-1">
                    {group.entries.map((entry) => (
                      <li key={entry.path} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={toDelete.has(entry.path)}
                          onChange={() => toggle(entry.path)}
                        />
                        {location && <Thumbnail loc={location} path={entry.path} alt={entry.name} />}
                        <span className={toDelete.has(entry.path) ? 'text-red-600 line-through dark:text-red-400' : ''}>
                          {recursive && recursiveFiles ? entry.path : entry.name}
                        </span>
                        {!toDelete.has(entry.path) && (
                          <span className="text-xs text-green-600 dark:text-green-400">keep</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {/* Rendering every group's thumbnails at once can crash the tab
                  at scale (confirmed on iPad Safari) — so only a bounded
                  number are ever in the DOM regardless of how many were
                  found. */}
              {duplicateGroups.length > visibleDupCount && (
                <button
                  onClick={() => setVisibleDupCount((n) => n + 20)}
                  className="mb-3 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Show {Math.min(20, duplicateGroups.length - visibleDupCount)} more (
                  {duplicateGroups.length - visibleDupCount} remaining)
                </button>
              )}

              {duplicateGroups.length > 0 && (
                <>
                  {resultMessage && <p className="mb-2 text-sm text-zinc-500">{resultMessage}</p>}
                  {deleteError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>}
                  <button
                    disabled={toDelete.size === 0 || deleting}
                    onClick={handleRemove}
                    className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {deleting
                      ? 'Removing…'
                      : `Remove ${toDelete.size} duplicate${toDelete.size === 1 ? '' : 's'} (frees ${formatBytes(bytesToFree)})`}
                  </button>

                  {deleteProgress && (
                    <div className="mt-3">
                      <p className="mb-1 text-xs text-zinc-500 truncate">
                        {deleteProgress.done}/{deleteProgress.total} — {deleteProgress.currentName}
                      </p>
                      <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                        <div
                          className="h-full bg-indigo-600 transition-all"
                          style={{
                            width: `${deleteProgress.total ? Math.round((deleteProgress.done / deleteProgress.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
                <h2 className="text-lg font-semibold">Similar images (not identical)</h2>
                <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
                  Approximate visual matching (recompressed/resized/lightly edited copies) — can include false
                  positives, so nothing is pre-selected. Open each file at full size before deciding what to remove.
                </p>

                {checkingPhashManifest && <p className="mb-2 text-xs text-zinc-500">Checking for a previous scan…</p>}
                {phashManifestError && (
                  <p className="mb-2 text-sm text-red-600 dark:text-red-400">{phashManifestError}</p>
                )}

                {!checkingPhashManifest && !phashManifestError && (
                  <>
                    <div className="mb-3 flex flex-wrap items-center gap-4">
                      {!phashRunning && phashRemainingCount > 0 && (
                        <button
                          disabled={effectiveFiles.length === 0}
                          onClick={startOrResumePhashScan}
                          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                        >
                          {phashMap && phashMap.size > 0
                            ? `Resume scan (${phashMap.size}/${phashRepresentatives.length} hashed)`
                            : 'Scan for similar images'}
                        </button>
                      )}
                      {phashRunning && (
                        <button
                          onClick={pausePhashScan}
                          className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          Pause
                        </button>
                      )}
                      {!phashRunning && phashRemainingCount === 0 && phashRepresentatives.length > 0 && (
                        <span className="text-sm text-zinc-500">
                          All {phashRepresentatives.length} distinct images hashed ✓
                        </span>
                      )}
                      {phashMap && phashMap.size > 0 && !phashRunning && (
                        <button onClick={resetPhashScan} className="text-xs text-zinc-500 hover:underline">
                          Reset cached hashes
                        </button>
                      )}
                      <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                        Threshold
                        <input
                          type="range"
                          min={0}
                          max={20}
                          value={similarThreshold}
                          onChange={(e) => setSimilarThreshold(Number(e.target.value))}
                          className="w-32"
                        />
                        <span className="text-xs">
                          {similarThreshold <= 5 ? 'Strict' : similarThreshold <= 12 ? 'Medium' : 'Loose'} (
                          {similarThreshold})
                        </span>
                      </label>
                    </div>

                    {phashRunning && phashProgress && (
                      <div className="mb-3">
                        <p className="mb-1 text-xs text-zinc-500">
                          Hashing {phashProgress.done}/{phashProgress.total}…
                        </p>
                        <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className="h-full bg-indigo-600 transition-all"
                            style={{
                              width: `${phashProgress.total ? Math.round((phashProgress.done / phashProgress.total) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {phashError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{phashError}</p>}
                    {phashMap && phashMap.size > 0 && similarGroups.length === 0 && (
                      <p className="text-sm text-zinc-500">No visually similar groups found at this threshold.</p>
                    )}
                  </>
                )}

                {similarGroups.slice(0, visibleSimilarCount).map((group, i) => (
                  <div key={i} className="mb-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="mb-2 text-xs text-zinc-500">{group.length} similar files</p>
                    <ul className="flex flex-col gap-2">
                      {group.map((entry) => (
                        <li key={entry.path} className="flex items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={similarSelected.has(entry.path)}
                            onChange={() => toggleSimilar(entry.path)}
                          />
                          {location && (
                            <button onClick={() => setViewingImage({ loc: location, path: entry.path })}>
                              <Thumbnail
                                loc={location}
                                path={entry.path}
                                alt={entry.name}
                                size="WM"
                                className="h-16 w-16 rounded object-cover cursor-pointer hover:opacity-80"
                              />
                            </button>
                          )}
                          <div className="flex flex-col">
                            <span
                              className={similarSelected.has(entry.path) ? 'text-red-600 line-through dark:text-red-400' : ''}
                            >
                              {recursive && recursiveFiles ? entry.path : entry.name}
                            </span>
                            <span className="text-xs text-zinc-400">{formatBytes(entry.size ?? 0)}</span>
                            {location && (
                              <button
                                onClick={() => setViewingImage({ loc: location, path: entry.path })}
                                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                              >
                                Open full size ⤢
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {similarGroups.length > visibleSimilarCount && (
                  <button
                    onClick={() => setVisibleSimilarCount((n) => n + 20)}
                    className="mb-3 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Show {Math.min(20, similarGroups.length - visibleSimilarCount)} more (
                    {similarGroups.length - visibleSimilarCount} remaining)
                  </button>
                )}

                {similarGroups.length > 0 && (
                  <>
                    {similarResultMessage && <p className="mb-2 text-sm text-zinc-500">{similarResultMessage}</p>}
                    {similarRemoveError && (
                      <p className="mb-2 text-sm text-red-600 dark:text-red-400">{similarRemoveError}</p>
                    )}
                    <button
                      disabled={similarSelected.size === 0 || similarRemoving}
                      onClick={handleRemoveSimilar}
                      className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {similarRemoving ? 'Removing…' : `Remove ${similarSelected.size} selected`}
                    </button>

                    {similarRemoveProgress && (
                      <div className="mt-3">
                        <p className="mb-1 text-xs text-zinc-500">
                          {similarRemoveProgress.done}/{similarRemoveProgress.total}
                        </p>
                        <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className="h-full bg-indigo-600 transition-all"
                            style={{
                              width: `${similarRemoveProgress.total ? Math.round((similarRemoveProgress.done / similarRemoveProgress.total) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {viewingImage && <ImageViewer loc={viewingImage.loc} path={viewingImage.path} onClose={() => setViewingImage(null)} />}
    </div>
  )
}
