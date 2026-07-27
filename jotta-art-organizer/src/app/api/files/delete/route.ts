import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { deleteFile } from '@/lib/jotta/client'

export async function POST(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const body = (await request.json()) as { device?: string; mountpoint?: string; path?: string }
    if (!body.device || !body.mountpoint || !body.path) {
      return NextResponse.json({ error: 'device, mountpoint, and path are required.' }, { status: 400 })
    }
    const pathSegments = body.path.split('/').filter(Boolean)
    await deleteFile(accessToken, username, body.device, body.mountpoint, pathSegments)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
