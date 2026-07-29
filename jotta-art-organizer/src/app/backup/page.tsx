'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FolderBrowser } from '@/components/FolderBrowser'
import { Thumbnail } from '@/components/Thumbnail'
import {
  getSessionStatus,
  createFolder,
  copyFile,
  walkTree,
  listFolder,
  type SessionStatus,
  type MountpointRef,
  type WalkEntry,
  type JottaFolderListing,
} from '@/lib/api'

type Location = { loc: MountpointRef; path: string }

type Conflict = { relPath: string; srcMd5: string; destMd5: string }

type Plan = {
  toCopy: WalkEntry[]
  matching: number
  conflicts: Conflict[]
  foldersToCreate: string[]
  totalBytes: number
}

type Progress = { done: number; total: number; currentName: string }
type Result = { copied: number; failed: { relPath: string; error: string }[] }

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

function joinPath(base: string, rel: string): string {
  return [base, rel].filter(Boolean).join('/')
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length
}

export default function BackupPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)

  const [source, setSource] = useState<Location | null>(null)
  const [pickingSource, setPickingSource] = useState(true)
  const [destination, setDestination] = useState<Location | null>(null)
  const [pickingDestination, setPickingDestination] = useState(false)

  const [sourceListingResult, setSourceListingResult] = useState<{ key: string; data: JottaFolderListing } | null>(
    null
  )
  const [sourceListingError, setSourceListingError] = useState<string | null>(null)
  const [manualSelection, setManualSelection] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())

  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)

  const [copying, setCopying] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  const sourceKey = source ? `${source.loc.device}/${source.loc.mountpoint}/${source.path}` : null

  useEffect(() => {
    if (!source || !sourceKey) return
    let ignore = false
    listFolder(source.loc, source.path)
      .then((listing) => {
        if (ignore) return
        setSourceListingResult({ key: sourceKey, data: listing })
        setSourceListingError(null)
        setManualSelection(false)
        setSelectedFiles(new Set(listing.files.map((f) => f.path)))
      })
      .catch((err) => {
        if (!ignore) setSourceListingError(err instanceof Error ? err.message : 'Failed to list source folder.')
      })
    return () => {
      ignore = true
    }
  }, [source, sourceKey])

  const sourceListing = sourceListingResult?.key === sourceKey ? sourceListingResult.data : null

  function toggleSelectedFile(path: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function runScan() {
    if (!source || !destination) return
    setScanning(true)
    setScanError(null)
    setPlan(null)
    setResult(null)
    try {
      let srcResult: { files: WalkEntry[]; folderRelPaths: string[] }
      let destResult: { files: WalkEntry[]; folderRelPaths: string[] }

      if (manualSelection) {
        // Flat mode: just the checked files, copied straight into the
        // destination folder — no subfolder structure involved.
        srcResult = {
          files: (sourceListing?.files ?? [])
            .filter((f) => f.md5 && selectedFiles.has(f.path))
            .map((f) => ({ relPath: f.name, absPath: f.path, md5: f.md5 as string, size: f.size ?? 0 })),
          folderRelPaths: [],
        }
        const destListing = await listFolder(destination.loc, destination.path)
        destResult = {
          files: destListing.files
            .filter((f) => f.md5)
            .map((f) => ({ relPath: f.name, absPath: f.path, md5: f.md5 as string, size: f.size ?? 0 })),
          folderRelPaths: [],
        }
      } else {
        ;[srcResult, destResult] = await Promise.all([
          walkTree(source.loc, source.path, { onFolder: (rel) => setScanProgress(`Scanning source: ${rel}`) }),
          walkTree(destination.loc, destination.path, {
            onFolder: (rel) => setScanProgress(`Scanning destination: ${rel}`),
          }),
        ])
      }

      const destByRel = new Map(destResult.files.map((f) => [f.relPath, f]))
      const toCopy: WalkEntry[] = []
      const conflicts: Conflict[] = []
      let matching = 0

      for (const f of srcResult.files) {
        const destFile = destByRel.get(f.relPath)
        if (!destFile) {
          toCopy.push(f)
        } else if (destFile.md5 === f.md5) {
          matching++
        } else {
          conflicts.push({ relPath: f.relPath, srcMd5: f.md5, destMd5: destFile.md5 })
        }
      }

      const destFolderSet = new Set(destResult.folderRelPaths)
      const foldersToCreate = srcResult.folderRelPaths.filter((f) => !destFolderSet.has(f))
      const totalBytes = toCopy.reduce((sum, f) => sum + f.size, 0)

      setPlan({ toCopy, matching, conflicts, foldersToCreate, totalBytes })
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Scan failed.')
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }

  async function runBackup() {
    if (!plan || !source || !destination) return
    setCopying(true)
    setResult(null)

    const foldersSorted = [...plan.foldersToCreate].sort((a, b) => depth(a) - depth(b))
    for (const rel of foldersSorted) {
      try {
        await createFolder(destination.loc, joinPath(destination.path, rel))
      } catch {
        // Best-effort — if it already exists (e.g. a previous interrupted
        // run got there first) a subsequent copy into it will still work;
        // if it genuinely fails, the copy attempts below will surface it.
      }
    }

    let copied = 0
    const failed: { relPath: string; error: string }[] = []
    for (const f of plan.toCopy) {
      setProgress({ done: copied, total: plan.toCopy.length, currentName: f.relPath })
      try {
        await copyFile(source.loc, f.absPath, destination.loc, joinPath(destination.path, f.relPath))
        copied++
      } catch (err) {
        failed.push({ relPath: f.relPath, error: err instanceof Error ? err.message : 'Copy failed.' })
      }
    }

    setProgress(null)
    setResult({ copied, failed })
    setCopying(false)
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Backup / copy between folders</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Recursively copies a whole folder tree to another location using Jottacloud&rsquo;s own server-side copy — no
          file bytes pass through this app. Safe to re-run: files already matching at the destination are skipped, and
          conflicting files (same name, different content) are reported, never overwritten.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          1. Source folder{source !== null && ` — ${source.loc.mountpoint}${source.path ? `/${source.path}` : ''}`}
        </h2>
        {pickingSource ? (
          <FolderBrowser
            selectLabel="Copy from"
            onSelect={(loc, path) => {
              setSource({ loc, path })
              setPickingSource(false)
              setPlan(null)
            }}
          />
        ) : (
          <button className="text-sm text-indigo-600 underline dark:text-indigo-400" onClick={() => setPickingSource(true)}>
            Change source
          </button>
        )}

        {source && !pickingSource && (
          <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            {sourceListingError && <p className="text-sm text-red-600 dark:text-red-400">{sourceListingError}</p>}
            {!sourceListingError && sourceListing === null && <p className="text-sm text-zinc-500">Loading files…</p>}
            {sourceListing && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={manualSelection}
                    onChange={(e) => setManualSelection(e.target.checked)}
                  />
                  Only copy specific files from this folder (instead of the whole folder tree)
                </label>

                {manualSelection && (
                  <div className="mt-2">
                    {sourceListing.folders.length > 0 && (
                      <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                        This folder also has {sourceListing.folders.length} subfolder
                        {sourceListing.folders.length === 1 ? '' : 's'}, which won&rsquo;t be included when selecting
                        individual files.
                      </p>
                    )}
                    {sourceListing.files.length === 0 ? (
                      <p className="text-sm text-zinc-500">No files directly in this folder.</p>
                    ) : (
                      <>
                        <div className="mb-2 flex gap-3 text-xs">
                          <button
                            className="text-indigo-600 hover:underline dark:text-indigo-400"
                            onClick={() => setSelectedFiles(new Set(sourceListing.files.map((f) => f.path)))}
                          >
                            Select all
                          </button>
                          <button
                            className="text-indigo-600 hover:underline dark:text-indigo-400"
                            onClick={() => setSelectedFiles(new Set())}
                          >
                            Select none
                          </button>
                        </div>
                        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                          {sourceListing.files.map((f) => (
                            <li key={f.path} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={selectedFiles.has(f.path)}
                                onChange={() => toggleSelectedFile(f.path)}
                              />
                              {source && <Thumbnail loc={source.loc} path={f.path} alt={f.name} px={64} />}
                              <span className="truncate">{f.name}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {source && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
            2. Destination folder
            {destination !== null &&
              ` — ${destination.loc.mountpoint}${destination.path ? `/${destination.path}` : ''}`}
          </h2>
          {pickingDestination || destination === null ? (
            <FolderBrowser
              selectLabel="Copy into"
              onSelect={(loc, path) => {
                setDestination({ loc, path })
                setPickingDestination(false)
                setPlan(null)
              }}
            />
          ) : (
            <button
              className="text-sm text-indigo-600 underline dark:text-indigo-400"
              onClick={() => setPickingDestination(true)}
            >
              Change destination
            </button>
          )}
        </section>
      )}

      {source && destination && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">3. Scan</h2>
          <button
            disabled={scanning || copying || (manualSelection && selectedFiles.size === 0)}
            onClick={runScan}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {scanning
              ? 'Scanning…'
              : plan
                ? 'Re-scan'
                : manualSelection
                  ? `Scan ${selectedFiles.size} selected file${selectedFiles.size === 1 ? '' : 's'}`
                  : 'Scan for differences'}
          </button>
          {manualSelection && selectedFiles.size === 0 && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">Select at least one file above first.</p>
          )}
          {scanning && scanProgress && <p className="mt-2 text-xs text-zinc-500">{scanProgress}</p>}
          {scanError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{scanError}</p>}
        </section>
      )}

      {plan && (
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Plan</h2>
          <ul className="mb-3 flex flex-col gap-1 text-sm">
            <li>
              <strong>{plan.toCopy.length}</strong> file{plan.toCopy.length === 1 ? '' : 's'} to copy (
              {formatBytes(plan.totalBytes)})
            </li>
            <li>
              <strong>{plan.foldersToCreate.length}</strong> folder{plan.foldersToCreate.length === 1 ? '' : 's'} to
              create
            </li>
            <li className="text-green-600 dark:text-green-400">
              <strong>{plan.matching}</strong> already match at destination — will be skipped
            </li>
            {plan.conflicts.length > 0 && (
              <li className="text-amber-600 dark:text-amber-400">
                <strong>{plan.conflicts.length}</strong> conflict{plan.conflicts.length === 1 ? '' : 's'} (same name,
                different content) — will NOT be touched
              </li>
            )}
          </ul>

          {plan.conflicts.length > 0 && (
            <details className="mb-3 text-xs text-zinc-500">
              <summary className="cursor-pointer">Show conflicts</summary>
              <ul className="mt-1 list-disc pl-4">
                {plan.conflicts.map((c) => (
                  <li key={c.relPath}>{c.relPath}</li>
                ))}
              </ul>
            </details>
          )}

          {plan.toCopy.length > 0 ? (
            <button
              disabled={copying}
              onClick={runBackup}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {copying ? 'Copying…' : `Start copying ${plan.toCopy.length} file${plan.toCopy.length === 1 ? '' : 's'}`}
            </button>
          ) : (
            <p className="text-sm text-zinc-500">Nothing to copy — destination is already up to date.</p>
          )}

          {progress && (
            <div className="mt-3">
              <p className="mb-1 text-xs text-zinc-500 truncate">
                {progress.done}/{progress.total} — {progress.currentName}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full bg-indigo-600 transition-all"
                  style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}

          {result && (
            <div className="mt-3 text-sm">
              <p className="text-green-600 dark:text-green-400">Copied {result.copied} file(s).</p>
              {result.failed.length > 0 && (
                <details className="mt-1 text-xs text-red-600 dark:text-red-400">
                  <summary className="cursor-pointer">{result.failed.length} failed — show details</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {result.failed.map((f) => (
                      <li key={f.relPath}>
                        {f.relPath}: {f.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {result.failed.length > 0 && (
                <p className="mt-2 text-zinc-500">Re-run the scan and copy again to retry just the failed ones.</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
