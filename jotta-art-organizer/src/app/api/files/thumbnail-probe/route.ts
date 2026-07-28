import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { listFolder } from '@/lib/jotta/client'

// Temporary diagnostic: asks Jottacloud for the same file's thumbnail once
// per candidate query-string form and reports what actually comes back, so
// the question "which parameter does JFS honour, and how big does it go?"
// is answered by measurement instead of assumption. Safe to delete.

const VARIANTS: { label: string; query: string }[] = [
  { label: '(no size param)', query: '' },
  { label: 'ts=WS', query: '&ts=WS' },
  { label: 'ts=WM', query: '&ts=WM' },
  { label: 'ts=WL', query: '&ts=WL' },
  { label: 'ts=WXL', query: '&ts=WXL' },
  { label: 'size=small', query: '&size=small' },
  { label: 'size=medium', query: '&size=medium' },
  { label: 'size=large', query: '&size=large' },
  { label: 'width=512', query: '&width=512' },
]

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    // Start-of-frame markers carry the real dimensions; C4/C8/CC are tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }
    }
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len <= 0) break
    i += 2 + len
  }
  return null
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0x89 || b[1] !== 0x50) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const q = request.nextUrl.searchParams
    const device = q.get('device')
    const mountpoint = q.get('mountpoint')
    if (!device || !mountpoint) {
      return NextResponse.json({ error: 'device and mountpoint are required.' }, { status: 400 })
    }

    // Either point at one file, or name a folder and let it pick the first image.
    let pathSegments = (q.get('path') ?? '').split('/').filter(Boolean)
    if (pathSegments.length === 0) {
      const folder = (q.get('folder') ?? '').split('/').filter(Boolean)
      const listing = await listFolder(accessToken, username, device, mountpoint, folder)
      const image = listing.files.find((f) => /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name))
      if (!image) {
        return NextResponse.json(
          { error: 'No image found directly in that folder — pass ?path= to a specific file.' },
          { status: 404 }
        )
      }
      pathSegments = image.path.split('/').filter(Boolean)
    }

    const base = `https://jfs.jottacloud.com/jfs/${[username, device, mountpoint, ...pathSegments]
      .map((s) => encodeURIComponent(s))
      .join('/')}`

    const results = await Promise.all(
      VARIANTS.map(async ({ label, query }) => {
        try {
          const res = await fetch(`${base}?mode=thumb${query}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (!res.ok) return { variant: label, status: res.status }
          const bytes = new Uint8Array(await res.arrayBuffer())
          const dims = jpegSize(bytes) ?? pngSize(bytes)
          return {
            variant: label,
            status: res.status,
            contentType: res.headers.get('content-type'),
            bytes: bytes.byteLength,
            dimensions: dims ? `${dims.width}x${dims.height}` : 'unknown',
          }
        } catch (err) {
          return { variant: label, error: err instanceof Error ? err.message : 'failed' }
        }
      })
    )

    return NextResponse.json({ file: pathSegments.join('/'), results }, { status: 200 })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Probe failed.' }, { status: 502 })
  }
}
