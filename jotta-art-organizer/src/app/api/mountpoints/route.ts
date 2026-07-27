import { NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { listMountpoints } from '@/lib/jotta/client'

export async function GET() {
  try {
    const { accessToken, username } = await requireAccessToken()
    const mountpoints = await listMountpoints(accessToken, username)
    return NextResponse.json({ mountpoints })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
