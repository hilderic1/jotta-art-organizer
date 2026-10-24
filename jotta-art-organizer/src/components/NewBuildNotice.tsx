'use client'

import { useCallback, useEffect, useState } from 'react'

/** The build this bundle came from, fixed when it was compiled. */
const RUNNING = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? 'development'

/**
 * Says when the page you are looking at is older than the one deployed.
 *
 * This app is loaded once and then navigated client-side, so it keeps running
 * whatever bundle it started with — a change can be deployed, verified and
 * live while the screen in front of you is unchanged, with nothing to say so.
 * That turned into "was it pushed?" more than once, a question neither of us
 * could answer from what was on screen.
 *
 * Checked when the app regains focus rather than on a timer: the moment you
 * come back to it is the moment a reload costs nothing.
 */
export function NewBuildNotice() {
  const [stale, setStale] = useState(false)

  const check = useCallback(async () => {
    // Nothing to compare in development, where every save already reloads.
    if (RUNNING === 'development') return
    try {
      const res = await fetch('/api/version', { cache: 'no-store' })
      if (!res.ok) return
      const { sha } = (await res.json()) as { sha?: string }
      if (sha && sha !== 'development' && sha !== RUNNING) setStale(true)
    } catch {
      // Offline, or the check itself is from an older build that has no such
      // route. Either way this is a convenience and never an obstacle.
    }
  }, [])

  useEffect(() => {
    let ignore = false
    // Written out rather than calling check(), so the state change is plainly
    // inside a promise callback: a render that starts by setting state is a
    // render done twice.
    if (RUNNING !== 'development') {
      fetch('/api/version', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { sha?: string } | null) => {
          const sha = data?.sha
          if (!ignore && sha && sha !== 'development' && sha !== RUNNING) setStale(true)
        })
        .catch(() => {
          // See check() — a convenience, never an obstacle.
        })
    }
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      ignore = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [check])

  if (!stale) return null

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 bg-indigo-600 px-4 py-1.5 text-xs text-white">
      <span>A newer version of this app is available — this page is still running an older one.</span>
      <button
        onClick={() => window.location.reload()}
        className="rounded bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
      >
        Reload
      </button>
    </div>
  )
}
