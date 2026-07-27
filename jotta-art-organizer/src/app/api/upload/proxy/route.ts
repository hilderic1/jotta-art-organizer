import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireAccessToken } from '@/lib/jotta/server'
import { allocateUpload } from '@/lib/jotta/client'

// Fallback path used only when the browser can't PUT/POST directly to
// Jottacloud's upload_url (e.g. blocked by CORS). Buffers the whole file
// in this function, so it's subject to the platform's request body size
// limit — fine for typical artwork exports, not for huge files.
export async function POST(request: NextRequest) {
  try {
    const { accessToken } = await requireAccessToken()

    const formData = await request.formData()
    const device = formData.get('device')
    const mountpoint = formData.get('mountpoint')
    const path = formData.get('path')
    const file = formData.get('file')

    if (
      typeof device !== 'string' ||
      !device ||
      typeof mountpoint !== 'string' ||
      !mountpoint ||
      typeof path !== 'string' ||
      !path ||
      !(file instanceof File)
    ) {
      return NextResponse.json({ error: 'device, mountpoint, path, and file are required.' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const md5 = crypto.createHash('md5').update(buffer).digest('hex')
    const pathSegments = path.split('/').filter(Boolean)
    const now = new Date()

    const allocation = await allocateUpload(
      accessToken,
      device,
      mountpoint,
      pathSegments,
      buffer.length,
      md5,
      now,
      now
    )

    if (allocation.state && allocation.state.toUpperCase() !== 'INCOMPLETE') {
      return NextResponse.json({ ok: true, deduped: true })
    }

    const uploadRes = await fetch(allocation.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    })

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => '')
      throw new Error(`Upload to Jottacloud failed (${uploadRes.status}): ${text.slice(0, 300)}`)
    }

    return NextResponse.json({ ok: true, deduped: false })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
