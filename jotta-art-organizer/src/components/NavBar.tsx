'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

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

export function NavBar() {
  const pathname = usePathname()

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
        {LINKS.map((link) => {
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
