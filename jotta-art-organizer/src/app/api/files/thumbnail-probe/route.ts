import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { listFolder } from '@/lib/jotta/client'

// Temporary diagnostic. Round 1 proved every size parameter on the JFS host
// returns the identical 1001-byte 30x30 image, so JFS stores exactly one
// thumbnail. Round 2 looks elsewhere: other JFS modes, and the newer
// api.jottacloud.com host (the same bearer token already works there — it's
// what upload allocation uses). Endpoint paths on that host are guesses, so
// 404s are expected and are themselves the answer. Safe to delete.

type Candidate = { label: string; url: string; range?: string; accept?: string }

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
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

    let segments = (q.get('path') ?? '').split('/').filter(Boolean)
    let md5 = q.get('md5') ?? ''
    if (segments.length === 0) {
      const folder = (q.get('folder') ?? '').split('/').filter(Boolean)
      const listing = await listFolder(accessToken, username, device, mountpoint, folder)
      const image = listing.files.find((f) => /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name))
      if (!image) {
        return NextResponse.json({ error: 'No image directly in that folder — pass ?path=' }, { status: 404 })
      }
      segments = image.path.split('/').filter(Boolean)
      md5 = image.md5 ?? ''
    }

    const enc = (parts: string[]) => parts.map((s) => encodeURIComponent(s)).join('/')
    const jfs = `https://jfs.jottacloud.com/jfs/${enc([username, device, mountpoint, ...segments])}`
    const rel = `/${enc([device, mountpoint, ...segments])}`
    const api = 'https://api.jottacloud.com'

    const candidates: Candidate[] = [
      // Baseline + the original, to anchor the comparison.
      { label: 'JFS ?mode=thumb (known 30x30)', url: `${jfs}?mode=thumb` },
      { label: 'JFS ?mode=bin (the original file, first 256KB)', url: `${jfs}?mode=bin`, range: 'bytes=0-262143' },
      // Other JFS modes we never tried.
      { label: 'JFS ?mode=preview', url: `${jfs}?mode=preview` },
      { label: 'JFS ?mode=thumb&ts=256 (numeric)', url: `${jfs}?mode=thumb&ts=256` },
      { label: 'JFS ?mode=thumb&size=WL', url: `${jfs}?mode=thumb&size=WL` },
      // Newer host — path-addressed.
      { label: 'files/v1 thumbnail?path=', url: `${api}/files/v1/thumbnail?path=${encodeURIComponent(rel)}&size=large` },
      { label: 'files/v1 thumb?path=', url: `${api}/files/v1/thumb?path=${encodeURIComponent(rel)}&size=large` },
      { label: 'files/v1 fetch?path=', url: `${api}/files/v1/fetch?path=${encodeURIComponent(rel)}&size=large` },
      // Newer host — content-hash addressed (how photo galleries usually work).
      ...(md5
        ? [
            { label: 'photos/v1 thumb by md5', url: `${api}/photos/v1/thumb/${md5}?size=large` },
            { label: 'photos/v1 photo/{md5}/thumbnail', url: `${api}/photos/v1/photo/${md5}/thumbnail?size=large` },
            { label: 'files/v1 thumbnail by md5', url: `${api}/files/v1/thumbnail/${md5}?size=large` },
          ]
        : []),
    ]

    const results = await Promise.all(
      candidates.map(async ({ label, url, range, accept }) => {
        try {
          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: accept ?? 'image/*',
              ...(range ? { Range: range } : {}),
            },
          })
          const contentType = res.headers.get('content-type')
          if (!res.ok) return { variant: label, status: res.status, contentType }
          const bytes = new Uint8Array(await res.arrayBuffer())
          const dims = jpegSize(bytes) ?? pngSize(bytes)
          return {
            variant: label,
            status: res.status,
            contentType,
            bytes: bytes.byteLength,
            dimensions: dims ? `${dims.width}x${dims.height}` : 'unknown',
          }
        } catch (err) {
          return { variant: label, error: err instanceof Error ? err.message : 'failed' }
        }
      })
    )

    return NextResponse.json({ file: segments.join('/'), md5: md5 || null, results }, { status: 200 })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Probe failed.' }, { status: 502 })
  }
}
