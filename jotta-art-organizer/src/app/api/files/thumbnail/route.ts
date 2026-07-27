import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { fetchThumbnail, type ThumbnailSize } from '@/lib/jotta/client'

const VALID_SIZES: ThumbnailSize[] = ['WS', 'WM', 'WL', 'WXL']

// Proxied because the browser has no way to attach the Bearer token
// Jottacloud requires onto a plain <img src>.
export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const device = request.nextUrl.searchParams.get('device')
    const mountpoint = request.nextUrl.searchParams.get('mountpoint')
    const path = request.nextUrl.searchParams.get('path')
    if (!device || !mountpoint || !path) {
      return NextResponse.json({ error: 'device, mountpoint, and path are required.' }, { status: 400 })
    }
    const sizeParam = request.nextUrl.searchParams.get('size')
    const size = VALID_SIZES.includes(sizeParam as ThumbnailSize) ? (sizeParam as ThumbnailSize) : 'WS'

    const pathSegments = path.split('/').filter(Boolean)
    const res = await fetchThumbnail(accessToken, username, device, mountpoint, pathSegments, size)

    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `Thumbnail not available (${res.status}).` }, { status: 404 })
    }

    return new NextResponse(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Failed to load thumbnail.' }, { status: 502 })
  }
}
