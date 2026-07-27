import { NextRequest, NextResponse } from 'next/server'
import { exchangePersonalLoginToken } from '@/lib/jotta/auth'
import { setSession } from '@/lib/jotta/session'

export async function POST(request: NextRequest) {
  let body: { personalLoginToken?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON body.' }, { status: 400 })
  }

  const token = body.personalLoginToken?.trim()
  if (!token) {
    return NextResponse.json({ error: 'personalLoginToken is required.' }, { status: 400 })
  }

  try {
    const { username, refreshToken, accessToken, expiresIn } = await exchangePersonalLoginToken(token)
    await setSession({ username, refreshToken, accessToken, accessTokenExpiresAt: Date.now() + expiresIn * 1000 })
    return NextResponse.json({ username })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during setup.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
