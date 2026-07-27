import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { fetchFile } from '@/lib/jotta/client'

// Streams the original file so it can be opened at full resolution — a
// browser link/tab can't attach the Bearer token Jottacloud requires, so
// this proxies it the same way the thumbnail route does.
export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const device = request.nextUrl.searchParams.get('device')
    const mountpoint = request.nextUrl.searchParams.get('mountpoint')
    const path = request.nextUrl.searchParams.get('path')
    if (!device || !mountpoint || !path) {
      return NextResponse.json({ error: 'device, mountpoint, and path are required.' }, { status: 400 })
    }

    const pathSegments = path.split('/').filter(Boolean)
    const range = request.headers.get('range') ?? undefined
    const res = await fetchFile(accessToken, username, device, mountpoint, pathSegments, { range })

    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `File not available (${res.status}).` }, { status: 404 })
    }

    const contentRange = res.headers.get('content-range')
    const contentLength = res.headers.get('content-length')
    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-cache',
        'Accept-Ranges': 'bytes',
        ...(contentRange ? { 'Content-Range': contentRange } : {}),
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Failed to load file.' }, { status: 502 })
  }
}
