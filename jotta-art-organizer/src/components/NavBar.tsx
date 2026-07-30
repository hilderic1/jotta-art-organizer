import Link from 'next/link'

const LINKS = [
  { href: '/import', label: 'Import' },
  { href: '/dedupe', label: 'Dedupe' },
  { href: '/backup', label: 'Copy' },
  { href: '/tags', label: 'Tags' },
  // Named rather than hidden behind the app title: account details and
  // Disconnect live here now, and a house icon doesn't say so.
  { href: '/setup', label: 'Setup' },
]

export function NavBar() {
  return (
    <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-200 bg-white/90 px-4 pb-2 backdrop-blur dark:border-zinc-800 dark:bg-black/90 [padding-top:max(0.5rem,env(safe-area-inset-top))]">
      {/* Points at setup rather than home: home now redirects to Tags, so a
          home link would be a no-op from the page you're already on, and
          account details live at setup. */}
      <Link href="/setup" className="text-sm font-semibold">
        🏠 Jotta Art Organizer
      </Link>
      <div className="ml-auto flex gap-4">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
