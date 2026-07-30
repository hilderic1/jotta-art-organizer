'use client'

import { useState, useEffect } from 'react'
import { viewUrl, type MountpointRef } from '@/lib/api'

export function ImageViewer({
  loc,
  path,
  onClose,
  title,
  tags,
  categories,
}: {
  loc: MountpointRef
  path: string
  onClose: () => void
  /** Shown above the tags when the file has one. */
  title?: string
  /** The file's tags, by category id. Omitted where there's nothing to show. */
  tags?: Record<string, string[]>
  /** Supplies display names; ids are shown raw if a category is missing. */
  categories?: { id: string; name: string }[]
}) {
  const [loading, setLoading] = useState(true)

  const nameFor = (categoryId: string) =>
    categories?.find((c) => c.id === categoryId)?.name ?? categoryId

  const entries = Object.entries(tags ?? {}).filter(([, values]) => values.length > 0)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      {/* Side by side on a wide screen, stacked on a narrow one — the panel
          below the image beats squeezing the picture on a phone. */}
      <div
        className="relative flex max-h-[90vh] w-full max-w-[95vw] flex-col gap-3 sm:flex-row sm:items-start sm:justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-9 right-0 rounded-lg bg-white/10 px-3 py-2 text-white hover:bg-white/20 dark:bg-black/40 dark:hover:bg-black/60"
          title="Close (ESC)"
        >
          ✕
        </button>

        <div className="relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
              <span className="text-sm text-zinc-400">Loading…</span>
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={viewUrl(loc, path)}
            alt={path}
            className="max-h-[70vh] rounded-lg object-contain sm:max-h-[90vh]"
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
          />
        </div>

        {entries.length > 0 && (
          <div className="max-h-[25vh] w-full overflow-y-auto rounded-lg bg-white/95 p-3 text-sm dark:bg-zinc-900/95 sm:max-h-[90vh] sm:w-64 sm:shrink-0">
            {title && <p className="mb-2 font-medium">{title}</p>}
            <div className="flex flex-col gap-2">
              {entries.map(([categoryId, values]) => (
                <div key={categoryId}>
                  <p className="text-xs font-medium text-zinc-500">{nameFor(categoryId)}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {values.map((value) => (
                      <span
                        key={value}
                        className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        {value}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
