import Link from 'next/link'

const LINKS = [
  { href: '/import', label: 'Import' },
  { href: '/dedupe', label: 'Dedupe' },
  { href: '/backup', label: 'Backup' },
  { href: '/tags', label: 'Tags' },
]

export function NavBar() {
  return (
    <nav className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-200 bg-white/90 px-4 pb-2 backdrop-blur dark:border-zinc-800 dark:bg-black/90 [padding-top:max(0.5rem,env(safe-area-inset-top))]">
      <Link href="/" className="text-sm font-semibold">
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
