'use client'

import { useEffect, useState } from 'react'
import type { JottaEntry } from '@/lib/api'

/**
 * The subfolders of the folder you're working in, folded away.
 *
 * Every screen that works on a folder is reached by choosing that folder
 * first, so its subfolders are a detour rather than the point — but one still
 * worth being able to take, which is why this collapses instead of hiding
 * them. Opening one collapses the list again: you've arrived.
 */
export function SubfolderList({
  folders,
  onOpen,
}: {
  folders: JottaEntry[]
  /** Given the subfolder's name, not its path — callers build the path from
   *  their own breadcrumbs. */
  onOpen: (name: string) => void
}) {
  const [open, setOpen] = useState(false)

  // A new listing means the folder changed under it.
  useEffect(() => {
    setOpen(false)
  }, [folders])

  if (folders.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        {open ? '▾' : '▸'} {folders.length} subfolder{folders.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          {folders.map((f) => (
            <li key={f.path}>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                onClick={() => onOpen(f.name)}
              >
                📁 {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
