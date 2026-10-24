'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getSessionStatus } from '@/lib/api'
import { loadModeConfig, toolsVisible } from '@/lib/mode'

const LINKS = [
  { href: '/import', label: 'Import' },
  { href: '/dedupe', label: 'Dedupe' },
  { href: '/copy', label: 'Copy' },
  { href: '/catalogue', label: 'Catalogue' },
  { href: '/inspect', label: 'Inspect' },
  // Named rather than hidden behind the app title: account details and
  // Disconnect live here now, and a house icon doesn't say so.
  { href: '/setup', label: 'Setup' },
]

/** What a focused mode keeps. Everything else is an instrument for looking
 *  into the account or tidying it up — still reachable by address, just not
 *  in the way of someone who opened the app to title a picture. */
const KEPT_IN_FOCUSED_MODES = new Set(['/import', '/copy', '/catalogue', '/setup'])

export function NavBar() {
  const pathname = usePathname()
  // Null until known, and everything is shown meanwhile: links appearing a
  // moment late is better than links vanishing a moment late.
  const [showTools, setShowTools] = useState(true)

  useEffect(() => {
    let ignore = false
    getSessionStatus()
      .then(async (session) => {
        if (!session.authenticated || !session.metadataLocation) return
        const config = await loadModeConfig(session.metadataLocation)
        if (!ignore) setShowTools(toolsVisible(config))
      })
      .catch(() => {
        // The mode is a convenience; failing to read it shows everything,
        // which is the state the app had before modes existed.
      })
    return () => {
      ignore = true
    }
  }, [pathname])

  const links = showTools ? LINKS : LINKS.filter((l) => KEPT_IN_FOCUSED_MODES.has(l.href))

  return (
    <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-200 bg-white/90 px-4 pb-2 backdrop-blur dark:border-zinc-800 dark:bg-black/90 [padding-top:max(0.5rem,env(safe-area-inset-top))]">
      {/* Points at setup rather than home: home now redirects to Tags, so a
          home link would be a no-op from the page you're already on, and
          account details live at setup. */}
      <Link href="/setup" className="text-sm font-semibold">
        🏠 Jotta Art Organizer
      </Link>
      <div className="ml-auto flex gap-4">
        {/* Marks where you are — six links with none of them highlighted left
            the question answerable only by reading the page. Matched on the
            prefix so a deeper route stays under its own section. */}
        {links.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'text-sm font-medium text-indigo-600 underline underline-offset-4 dark:text-indigo-400'
                  : 'text-sm text-zinc-600 hover:underline dark:text-zinc-400'
              }
            >
              {link.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
