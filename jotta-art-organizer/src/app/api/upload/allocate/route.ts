import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { allocateUpload } from '@/lib/jotta/client'

export async function POST(request: NextRequest) {
  try {
    const { accessToken } = await requireAccessToken()
    const body = (await request.json()) as {
      device?: string
      mountpoint?: string
      path?: string
      bytes?: number
      md5?: string
    }

    if (!body.device || !body.mountpoint || !body.path || typeof body.bytes !== 'number' || !body.md5) {
      return NextResponse.json(
        { error: 'device, mountpoint, path, bytes, and md5 are required.' },
        { status: 400 }
      )
    }

    const pathSegments = body.path.split('/').filter(Boolean)
    const now = new Date()

    const allocation = await allocateUpload(
      accessToken,
      body.device,
      body.mountpoint,
      pathSegments,
      body.bytes,
      body.md5,
      now,
      now
    )

    // The client needs this access token to PUT the file bytes directly to
    // Jottacloud's upload_url (bypassing our server, which avoids Vercel's
    // request-body size limit). It's the same short-lived (~1hr) token the
    // user's own session already holds — never the longer-lived refresh
    // token, which stays server-side only.
    return NextResponse.json({ ...allocation, accessToken })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
