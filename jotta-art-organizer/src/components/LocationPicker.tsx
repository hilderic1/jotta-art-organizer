'use client'

import { useEffect, useState } from 'react'
import { listMountpoints, listFolder, type MountpointRef, type JottaEntry } from '@/lib/api'

export function LocationPicker({ onSelect }: { onSelect: (loc: MountpointRef & { path?: string }) => void }) {
  const [mountpoints, setMountpoints] = useState<MountpointRef[] | null>(null)
  const [currentLoc, setCurrentLoc] = useState<MountpointRef | null>(null)
  const [currentPath, setCurrentPath] = useState('')
  const [folderContents, setFolderContents] = useState<JottaEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let ignore = false
    listMountpoints()
      .then((mps) => {
        if (!ignore) setMountpoints(mps)
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Failed to list Jottacloud devices.')
      })
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!currentLoc) return
    let ignore = false
    setLoading(true)
    setError(null)
    listFolder(currentLoc, currentPath)
      .then((listing) => {
        if (!ignore) {
          setFolderContents(listing.folders)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Failed to list folder.')
          setLoading(false)
        }
      })
    return () => {
      ignore = true
    }
  }, [currentLoc, currentPath])

  const navigateInto = (folderName: string) => {
    const newPath = currentPath ? `${currentPath}/${folderName}` : folderName
    setCurrentPath(newPath)
  }

  const navigateBack = () => {
    const parts = currentPath.split('/')
    parts.pop()
    setCurrentPath(parts.join('/'))
  }

  const selectCurrent = () => {
    if (!currentLoc) return
    onSelect({ ...currentLoc, path: currentPath || undefined })
  }

  if (!mountpoints) {
    return (
      <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
          Choose a location
        </div>
        <div className="min-h-[120px] p-3">
          <p className="text-sm text-zinc-500">Loading…</p>
        </div>
      </div>
    )
  }

  if (currentLoc) {
    return (
      <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
          {currentPath ? `${currentLoc.mountpoint}/${currentPath}` : currentLoc.mountpoint}
        </div>
        <div className="min-h-[120px] p-3">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {loading && <p className="text-sm text-zinc-500">Loading…</p>}
          {!loading && folderContents && folderContents.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {folderContents.map((entry) => (
                <li key={entry.name}>
                  <button
                    className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                    onClick={() => navigateInto(entry.name)}
                  >
                    🗂 {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && (!folderContents || folderContents.length === 0) && (
            <p className="text-sm text-zinc-500">No folders</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                setCurrentLoc(null)
                setCurrentPath('')
                setFolderContents(null)
              }}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              ← Back to mountpoints
            </button>
            {currentPath && (
              <button
                onClick={navigateBack}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                ← Up one level
              </button>
            )}
            <button
              onClick={selectCurrent}
              className="ml-auto rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Select
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
        Choose a location
      </div>
      <div className="min-h-[120px] p-3">
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {mountpoints.map((mp) => (
            <li key={`${mp.device}/${mp.mountpoint}`}>
              <button
                className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                onClick={() => setCurrentLoc(mp)}
              >
                🗂 {mp.mountpoint} <span className="text-xs text-zinc-400">— {mp.device}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
