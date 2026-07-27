import { NextRequest, NextResponse } from 'next/server'
import { getSession, setSession } from '@/lib/jotta/session'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
  }

  const body = (await request.json()) as { device?: string; mountpoint?: string }
  if (!body.device || !body.mountpoint) {
    return NextResponse.json({ error: 'device and mountpoint are required.' }, { status: 400 })
  }

  await setSession({ ...session, metadataLocation: { device: body.device, mountpoint: body.mountpoint } })
  return NextResponse.json({ ok: true })
}
