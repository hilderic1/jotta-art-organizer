import { NextResponse } from 'next/server'
import { getSession, clearSession } from '@/lib/jotta/session'

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ authenticated: false })
  }
  return NextResponse.json({
    authenticated: true,
    username: session.username,
    metadataLocation: session.metadataLocation ?? null,
  })
}

export async function DELETE() {
  await clearSession()
  return NextResponse.json({ ok: true })
}
