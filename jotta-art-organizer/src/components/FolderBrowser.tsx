'use client'

import { useEffect, useState } from 'react'
import {
  listFolder,
  createFolder,
  listMountpoints,
  type JottaFolderListing,
  type MountpointRef,
} from '@/lib/api'

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function FolderBrowser({
  onSelect,
  selectLabel = 'Use this folder',
}: {
  onSelect?: (loc: MountpointRef, path: string) => void
  selectLabel?: string
}) {
  const [location, setLocation] = useState<MountpointRef | null>(null)
  const [mountpoints, setMountpoints] = useState<MountpointRef[] | null>(null)
  const [mountpointsError, setMountpointsError] = useState<string | null>(null)

  const [path, setPath] = useState('')
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [result, setResult] = useState<{ path: string; data: JottaFolderListing } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

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
          setResult({ path, data })
          setError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Failed to load folder.')
      })
    return () => {
      ignore = true
    }
  }, [location, path, refreshIndex])

  if (location === null) {
    return (
      <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
          Choose a location
        </div>
        <div className="min-h-[120px] p-3">
          {mountpointsError && <p className="text-sm text-red-600 dark:text-red-400">{mountpointsError}</p>}
          {!mountpointsError && mountpoints === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {mountpoints && mountpoints.length === 0 && (
            <p className="text-sm text-zinc-500">No devices found on this account.</p>
          )}
          {mountpoints && mountpoints.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {mountpoints.map((mp) => (
                <li key={`${mp.device}/${mp.mountpoint}`}>
                  <button
                    className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                    onClick={() => {
                      setLocation(mp)
                      setPath('')
                      setResult(null)
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
    )
  }

  const loading = result === null || result.path !== path
  const listing = result && result.path === path ? result.data : null
  const crumbs = segments(path)

  async function handleCreateFolder() {
    const name = newFolderName.trim()
    if (!name || !location) return
    const fullPath = [...crumbs, name].join('/')
    setError(null)
    try {
      await createFolder(location, fullPath)
      setNewFolderName('')
      setCreating(false)
      setRefreshIndex((i) => i + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder.')
    }
  }

  return (
    <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <button
          className="text-zinc-500 hover:underline"
          onClick={() => {
            setLocation(null)
            setMountpoints(null)
            setResult(null)
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

      <div className="min-h-[160px] p-3">
        {loading && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!loading && !error && listing && listing.folders.length === 0 && (
          <p className="text-sm text-zinc-500">No subfolders yet.</p>
        )}
        {!loading && !error && listing && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {listing.folders.map((f) => (
              <li key={f.path}>
                <button
                  className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                  onClick={() => setPath([...crumbs, f.name].join('/'))}
                >
                  📁 {f.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        {creating ? (
          <>
            <input
              autoFocus
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <button className="text-sm font-medium text-indigo-600 dark:text-indigo-400" onClick={handleCreateFolder}>
              Create
            </button>
            <button className="text-sm text-zinc-500" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="text-sm font-medium text-indigo-600 dark:text-indigo-400" onClick={() => setCreating(true)}>
            + New folder
          </button>
        )}

        {onSelect && (
          <button
            className="ml-auto rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            onClick={() => onSelect(location, path)}
          >
            {selectLabel}: {location.mountpoint}
            {path ? `/${path}` : ''}
          </button>
        )}
      </div>
    </div>
  )
}
