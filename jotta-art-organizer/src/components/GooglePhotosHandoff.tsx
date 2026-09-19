'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArchivedPhoto } from '@/lib/takeoutCheck'
import { buildSelectorList } from '@/lib/gphotosList'

function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['Europe/Lisbon', 'Europe/Brussels', 'Europe/London', 'America/New_York', 'America/Chicago']
  }
}

/**
 * Hands the checked export over to Google Photos: a list of capture times to
 * tick, and the script that ticks them.
 *
 * The two can't talk directly — the script runs on Google's site, which can't
 * read this app's data — so the list travels by the clipboard.
 */
export function GooglePhotosHandoff({ archived }: { archived: ArchivedPhoto[] }) {
  const [homeZone, setHomeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [copied, setCopied] = useState<'list' | 'script' | null>(null)
  const [script, setScript] = useState<string | null>(null)
  const bookmarklet = useRef<HTMLAnchorElement>(null)

  const built = useMemo(() => buildSelectorList(archived, homeZone), [archived, homeZone])

  // Served as a plain file so it stays readable and can be pasted into a
  // console as-is.
  useEffect(() => {
    fetch('/gphotos-select.js')
      .then((r) => r.text())
      .then(setScript)
      .catch(() => setScript(null))
  }, [])

  // Set outside React: it refuses javascript: URLs in href as a safety
  // measure, and a bookmarklet is exactly one.
  useEffect(() => {
    if (script && bookmarklet.current) {
      bookmarklet.current.setAttribute('href', `javascript:${encodeURIComponent(script)}`)
    }
  }, [script])

  async function copy(what: 'list' | 'script') {
    const text = what === 'list' ? JSON.stringify(built.list) : script
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 2500)
  }

  if (archived.length === 0) return null

  return (
    <section className="rounded border border-indigo-300 p-3 text-sm dark:border-indigo-800">
      <h2 className="font-medium">Tick them in Google Photos</h2>
      <p className="mt-1 text-xs text-zinc-500">
        A helper that runs on the Google Photos website and ticks the{' '}
        {archived.length.toLocaleString()} photos confirmed safe here — matched by the moment each was taken —
        then stops. It never deletes: you look over the selection and press the bin yourself. Best done on a
        computer.
      </p>

      {/* Photos without a location can't have their time zone worked out, and
          Google labels photos in local time where they were taken. */}
      {built.unlocated > 0 && (
        <label className="mt-3 block text-xs">
          <span className="text-zinc-600 dark:text-zinc-400">
            {built.unlocated.toLocaleString()} of them have no location. Where were most of those taken?
          </span>
          <select
            value={homeZone}
            onChange={(e) => setHomeZone(e.target.value)}
            className="mt-1 block rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {allZones().map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-zinc-400">
            Any taken elsewhere simply won&rsquo;t match, so they&rsquo;re left unticked rather than ticked wrongly.
          </span>
        </label>
      )}

      <ol className="mt-3 list-decimal pl-5 text-xs text-zinc-600 dark:text-zinc-400">
        <li className="py-1">
          Drag this to your bookmarks bar:{' '}
          <a
            ref={bookmarklet}
            href="#"
            onClick={(e) => e.preventDefault()}
            className="rounded bg-zinc-200 px-2 py-0.5 font-medium text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100"
            title="Drag me to the bookmarks bar"
          >
            Select archived photos
          </a>
          <span className="block text-zinc-400">
            Or, if your browser won&rsquo;t keep it: press F12 on the Google Photos page, open Console, and paste{' '}
            <button onClick={() => copy('script')} disabled={!script} className="text-indigo-600 hover:underline dark:text-indigo-400">
              {copied === 'script' ? 'copied ✓' : 'the script'}
            </button>
            .
          </span>
        </li>
        <li className="py-1">
          <button
            onClick={() => copy('list')}
            className="rounded bg-indigo-600 px-2 py-0.5 font-medium text-white hover:bg-indigo-500"
          >
            {copied === 'list' ? 'Copied ✓' : 'Copy the list'}
          </button>
        </li>
        <li className="py-1">
          Open photos.google.com, click the bookmark, paste the list into the box that appears, and press Start.
        </li>
        <li className="py-1">
          When it finishes, check the selection — the count, and any moments it lists for checking by eye —
          then press Google&rsquo;s bin button yourself if you&rsquo;re happy.
        </li>
      </ol>
    </section>
  )
}
