import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { createFolder, listFolder } from '@/lib/jotta/client'

function splitPath(path: string | null): string[] {
  if (!path) return []
  return path.split('/').filter(Boolean)
}

export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const device = request.nextUrl.searchParams.get('device')
    const mountpoint = request.nextUrl.searchParams.get('mountpoint')
    if (!device || !mountpoint) {
      return NextResponse.json({ error: 'device and mountpoint are required.' }, { status: 400 })
    }
    const path = splitPath(request.nextUrl.searchParams.get('path'))
    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true'
    const listing = await listFolder(accessToken, username, device, mountpoint, path, { includeDeleted })
    return NextResponse.json(listing)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const body = (await request.json()) as { device?: string; mountpoint?: string; path?: string }
    if (!body.device || !body.mountpoint) {
      return NextResponse.json({ error: 'device and mountpoint are required.' }, { status: 400 })
    }
    const path = splitPath(body.path ?? null)
    if (path.length === 0) {
      return NextResponse.json({ error: 'path is required.' }, { status: 400 })
    }
    const folder = await createFolder(accessToken, username, body.device, body.mountpoint, path)
    return NextResponse.json(folder)
  } catch (err) {
    return errorResponse(err)
  }
}

function errorResponse(err: unknown) {
  if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
    return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
  }
  const message = err instanceof Error ? err.message : 'Unknown error.'
  return NextResponse.json({ error: message }, { status: 502 })
}
