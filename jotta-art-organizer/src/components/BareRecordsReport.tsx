'use client'

import { useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { findBareRecords, type BareReport } from '@/lib/bareRecords'

/**
 * How much describing is actually missing, after recovery has taken what it
 * can.
 *
 * The overwriting bug left a signature — a record carrying only the tags the
 * app derives from the file — so what it cost can be counted rather than
 * discovered one folder at a time. It cannot tell that apart from a picture
 * nobody has described yet, and doesn't pretend to: either way the answer is
 * the same, and knowing whether it is ten pictures or a thousand is the point.
 */
export function BareRecordsReport({ metadataLoc }: { metadataLoc: MountpointRef }) {
  const [report, setReport] = useState<BareReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)
  const [showRest, setShowRest] = useState(false)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setReport(await findBareRecords(metadataLoc))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the catalogue.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">What still has nothing written about it</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Counts the pictures whose record holds only what the app read out of the file — a date, a camera,
        a program name — and nothing anyone typed.
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Expect this to be most of a photo library: a bulk import describes every picture from its file,
        and nobody hand-titles sixty thousand photographs. A large untyped count is not damage on its
        own. What is worth looking at is a folder holding <em>some</em> typed tags and many without —
        describing that was started, and so describing that may have been lost.
      </p>

      <button
        onClick={() => void run()}
        disabled={busy}
        className="mt-2 rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {busy ? 'Reading the whole catalogue…' : 'Count them'}
      </button>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {report && (
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <p>
            <strong>{report.described.toLocaleString()}</strong> of{' '}
            {report.total.toLocaleString()} pictures carry something written by hand.{' '}
            <strong>{report.bare.toLocaleString()}</strong> carry only what the file said.
          </p>

          {/* Which typed categories are in use at all: a title count of zero
              means titles were never used, not that they were all lost. */}
          {report.typedCategories.length > 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              {report.typedCategories
                .map(({ name, count }) => `${name}: ${count.toLocaleString()}`)
                .join(' · ')}
            </p>
          ) : (
            <p className="text-amber-700 dark:text-amber-500">
              No picture in the catalogue carries anything typed by hand. If that is wrong, recovery
              hasn&rsquo;t found it yet — try the other devices before accepting this number.
            </p>
          )}

          {/* The short list, in full and without being asked for. Everything
              else here is a tally of an ordinary photo library, and it was
              burying the few dozen pictures actually worked on. */}
          {report.describedRecords.length > 0 && (
            <div>
              <p className="text-zinc-500">
                The {report.describedRecords.length.toLocaleString()} with something typed:
              </p>
              <ul className="mt-1 flex max-h-96 flex-col gap-0.5 overflow-y-auto text-[11px]">
                {report.describedRecords.map((r) => (
                  <li key={r.md5} className="border-b border-zinc-100 py-0.5 dark:border-zinc-900">
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">
                      {r.path.split('/').pop() || r.md5}
                    </span>
                    <span className="block text-zinc-600 dark:text-zinc-400">{r.typed}</span>
                    <span className="block font-mono text-zinc-400">
                      {r.path.slice(0, r.path.lastIndexOf('/')) || '(no folder recorded)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={() => setShowRest((v) => !v)}
            className="self-start text-zinc-500 hover:underline"
          >
            {showRest ? 'Hide the rest' : 'Show the folder tally and the untyped ones'}
          </button>

          {showRest && report.byFolder.length > 0 && (
            <div>
              {/* Folders that hold some of each first. A folder of thousands
                  with nothing typed anywhere is a folder nobody has described
                  — not a loss — and putting those at the top made a normal
                  photo library look like a catastrophe. */}
              <p className="text-zinc-500">
                Per folder, typed against untyped. Folders holding some of each come first: those are
                where describing was started, so those are where something may be missing. A folder with
                none at all is one nobody has described, however large it is.
              </p>
              <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                {report.byFolder.slice(0, 40).map((f) => (
                  <li key={f.folder} className={f.described > 0 ? 'text-zinc-800 dark:text-zinc-200' : undefined}>
                    {f.described > 0 ? `${f.described.toLocaleString()} typed, ` : ''}
                    {f.bare.toLocaleString()} untyped — {f.folder}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showRest && report.examples.length > 0 && (
            <>
              <button
                onClick={() => setShowList((v) => !v)}
                className="self-start text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {showList
                  ? 'Hide them'
                  : `Show the first ${Math.min(report.examples.length, 200).toLocaleString()}`}
              </button>
              {showList && (
                <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto font-mono text-[11px]">
                  {report.examples.map((e) => (
                    <li key={e.md5} className="border-b border-zinc-100 py-0.5 dark:border-zinc-900">
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {e.path.split('/').pop() || e.md5}
                      </span>
                      <span className="block text-zinc-500">{e.derived || 'nothing at all'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
