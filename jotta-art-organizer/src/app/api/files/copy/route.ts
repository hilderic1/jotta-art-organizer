import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { copyFile } from '@/lib/jotta/client'

export async function POST(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const body = (await request.json()) as {
      srcDevice?: string
      srcMountpoint?: string
      srcPath?: string
      destDevice?: string
      destMountpoint?: string
      destPath?: string
    }
    if (
      !body.srcDevice ||
      !body.srcMountpoint ||
      !body.srcPath ||
      !body.destDevice ||
      !body.destMountpoint ||
      !body.destPath
    ) {
      return NextResponse.json(
        { error: 'srcDevice, srcMountpoint, srcPath, destDevice, destMountpoint, and destPath are required.' },
        { status: 400 }
      )
    }

    await copyFile(
      accessToken,
      username,
      body.srcDevice,
      body.srcMountpoint,
      body.srcPath.split('/').filter(Boolean),
      body.destDevice,
      body.destMountpoint,
      body.destPath.split('/').filter(Boolean)
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
