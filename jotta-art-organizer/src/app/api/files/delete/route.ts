import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { deleteFile, deleteFolder } from '@/lib/jotta/client'

export async function POST(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const body = (await request.json()) as {
      device?: string
      mountpoint?: string
      path?: string
      /** Folders take a different JFS verb; absent means a file, which is
       *  what every caller before folder cleanup existed meant. */
      kind?: 'file' | 'folder'
    }
    if (!body.device || !body.mountpoint || !body.path) {
      return NextResponse.json({ error: 'device, mountpoint, and path are required.' }, { status: 400 })
    }
    const pathSegments = body.path.split('/').filter(Boolean)
    const remove = body.kind === 'folder' ? deleteFolder : deleteFile
    await remove(accessToken, username, body.device, body.mountpoint, pathSegments)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
