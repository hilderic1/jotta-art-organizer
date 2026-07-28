import sharp from 'sharp'
import { fetchFile, fetchThumbnail } from './client'

// Measured, not assumed: nine different query forms against JFS
// (?mode=thumb with ts=WS|WM|WL|WXL, size=small|medium|large, width=, and no
// parameter at all) all returned byte-identical 1001-byte 30x30 JPEGs, while
// the original was 3200x3200. JFS keeps exactly one thumbnail and ignores the
// size parameter, so any larger rendition has to come from the original file.
export const JFS_THUMB_PX = 30

export type RenderedImage = { body: Buffer; contentType: string; cacheable: boolean }

// Anything at or below what JFS already stores is served straight from JFS —
// far cheaper than pulling a multi-megabyte original just to shrink it.
export async function renderImage(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  pathSegments: string[],
  px: number
): Promise<RenderedImage | null> {
  if (px <= JFS_THUMB_PX) {
    const res = await fetchThumbnail(accessToken, username, device, mountpoint, pathSegments)
    if (!res.ok) return null
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/jpeg',
      cacheable: true,
    }
  }

  const res = await fetchFile(accessToken, username, device, mountpoint, pathSegments)
  if (!res.ok) return null

  // `fit: inside` keeps the aspect ratio and never enlarges a source that is
  // already smaller than the requested box, so a small original stays sharp
  // instead of being upscaled into the same mush we're trying to fix.
  const resized = await sharp(Buffer.from(await res.arrayBuffer()))
    .rotate()
    .resize(px, px, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()

  return { body: resized, contentType: 'image/jpeg', cacheable: true }
}
