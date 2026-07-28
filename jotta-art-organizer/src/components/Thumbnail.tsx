'use client'

import { useState } from 'react'
import { thumbnailUrl, ICON_PX, type MountpointRef } from '@/lib/api'

export function Thumbnail({
  loc,
  path,
  alt,
  px = ICON_PX,
  className = 'h-8 w-8 shrink-0 rounded object-cover',
}: {
  loc: MountpointRef
  path: string
  alt: string
  /** Rendered width in pixels. ICON_PX serves Jottacloud's stored 30x30 icon;
   *  anything larger is resized from the original, so use it only where a
   *  handful of images are on screen, not in list views of thousands. */
  px?: number
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
    <img
      src={thumbnailUrl(loc, path, px)}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setErrored(true)}
    />
  )
}
