'use client'

import { useEffect, useState } from 'react'
import { listMountpoints, type MountpointRef } from '@/lib/api'

export function LocationPicker({ onSelect }: { onSelect: (loc: MountpointRef) => void }) {
  const [mountpoints, setMountpoints] = useState<MountpointRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
        Choose a location
      </div>
      <div className="min-h-[120px] p-3">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!error && mountpoints === null && <p className="text-sm text-zinc-500">Loading…</p>}
        {mountpoints && mountpoints.length > 0 && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {mountpoints.map((mp) => (
              <li key={`${mp.device}/${mp.mountpoint}`}>
                <button
                  className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                  onClick={() => onSelect(mp)}
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
