import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { listFileRevisions, fetchFileRevision } from '@/lib/jotta/client'

/**
 * The versions Jottacloud keeps of a file, and the contents of one of them.
 *
 * Without `revision`, lists what history exists. With it, returns that
 * version's bytes — which is how tags written over by a bad save are read
 * back without anyone downloading a few hundred files by hand.
 */
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
    const wanted = request.nextUrl.searchParams.get('revision')

    if (wanted === null) {
      const revisions = await listFileRevisions(accessToken, username, device, mountpoint, pathSegments)
      return NextResponse.json({ revisions })
    }

    const revision = Number(wanted)
    if (!Number.isFinite(revision)) {
      return NextResponse.json({ error: 'revision must be a number.' }, { status: 400 })
    }
    const res = await fetchFileRevision(
      accessToken,
      username,
      device,
      mountpoint,
      pathSegments,
      revision
    )
    if (!res.ok) {
      return NextResponse.json(
        { error: `Jottacloud answered ${res.status} for revision ${revision}.` },
        { status: 502 }
      )
    }
    // Passed through as text: every caller of this is reading a JSON file
    // out of the catalogue, and a stream would only be re-read as text.
    return new NextResponse(await res.text(), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
