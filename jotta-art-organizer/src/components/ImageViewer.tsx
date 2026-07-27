'use client'

import { useState, useEffect } from 'react'
import { viewUrl, type MountpointRef } from '@/lib/api'

export function ImageViewer({
  loc,
  path,
  onClose,
}: {
  loc: MountpointRef
  path: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 rounded-lg bg-white/10 px-3 py-2 text-white hover:bg-white/20 dark:bg-black/40 dark:hover:bg-black/60"
          title="Close (ESC)"
        >
          ✕
        </button>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
            <span className="text-sm text-zinc-400">Loading…</span>
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={viewUrl(loc, path)}
          alt={path}
          className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          onLoad={() => setLoading(false)}
          onError={() => setLoading(false)}
        />
      </div>
    </div>
  )
}
