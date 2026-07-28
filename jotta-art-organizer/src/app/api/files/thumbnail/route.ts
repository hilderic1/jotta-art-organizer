import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { renderImage, JFS_THUMB_PX } from '@/lib/jotta/render'

// Renders are capped so a crafted URL can't ask the function to produce
// arbitrarily large images from every file in the library.
const MAX_PX = 1024

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

    const requested = Number(request.nextUrl.searchParams.get('px'))
    const px = Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1), MAX_PX) : JFS_THUMB_PX

    const pathSegments = path.split('/').filter(Boolean)
    const rendered = await renderImage(accessToken, username, device, mountpoint, pathSegments, px)
    if (!rendered) {
      return NextResponse.json({ error: 'Thumbnail not available.' }, { status: 404 })
    }

    return new NextResponse(new Uint8Array(rendered.body), {
      headers: {
        'Content-Type': rendered.contentType,
        // Immutable per (file, size): resizing the same bytes always yields
        // the same image, and an edited file lands at a different path or
        // hash. Long-lived so a repeat view costs no Jottacloud round-trip.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Failed to load thumbnail.' }, { status: 502 })
  }
}
