import { NextResponse } from 'next/server'

/**
 * Which build is deployed right now.
 *
 * The page you are looking at was built once and keeps running the code it
 * started with: moving between pages is client-side, so a deploy changes
 * nothing until a full page load. That made "was the change pushed?" a
 * question nobody on either side could answer from what was on screen.
 *
 * Answered per request and never cached, so the value is the deployment's
 * rather than the one baked into whatever bundle is asking.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? 'development' },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
