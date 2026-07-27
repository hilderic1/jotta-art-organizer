'use client'

import { useState } from 'react'
import { thumbnailUrl, type MountpointRef, type ThumbnailSize } from '@/lib/api'

export function Thumbnail({
  loc,
  path,
  alt,
  size = 'WS',
  className = 'h-8 w-8 shrink-0 rounded object-cover',
}: {
  loc: MountpointRef
  path: string
  alt: string
  size?: ThumbnailSize
  className?: string
}) {
  const [errored, setErrored] = useState(false)

  if (errored) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded bg-zinc-100 text-sm dark:bg-zinc-800 ${className}`}>
        📄
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied, per-file, auth-gated: not a fit for next/image
    <img src={thumbnailUrl(loc, path, size)} alt={alt} className={className} onError={() => setErrored(true)} />
  )
}
