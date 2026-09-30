'use client'

import { useRef, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { planRestore, applyRestore, type RestorePlan } from '@/lib/restoreTags'

/**
 * Puts back tags that describing-on-arrival wrote over, from older versions of
 * the shard files downloaded out of Jottacloud.
 *
 * Only fills holes. A tag that exists today is today's answer, whatever an
 * older copy of the file says — so this cannot undo work done since, and
 * running it twice does nothing the second time.
 */
export function RestoreTags({ metadataLoc }: { metadataLoc: MountpointRef }) {
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [restored, setRestored] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function read(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy('Reading the files…')
    setError(null)
    setPlan(null)
    setRestored(null)
    try {
      const read = await Promise.all(
        Array.from(files).map(async (f) => ({ name: f.name, text: await f.text() }))
      )
      setNames(read.map((f) => f.name))
      setBusy('Comparing against the catalogue…')
      setPlan(await planRestore(metadataLoc, read))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read those files.')
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    if (!plan) return
    setBusy('Putting them back…')
    setError(null)
    try {
      setRestored(await applyRestore(metadataLoc, plan))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not write them back.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Put back tags that were written over</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Filing a picture used to replace its record rather than add to it, so titles and anything else
        typed by hand were lost. Each overwrite left a previous version of a tag file in Jottacloud.
        Download those and hand them over here — only what the catalogue is now missing is put back, so
        nothing done since can be undone.{' '}
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {open ? 'Hide' : 'How to get them'}
        </button>
      </p>

      {open && (
        <ol className="mt-2 list-decimal pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          <li className="py-0.5">
            In Jottacloud&rsquo;s website, open{' '}
            <code>{metadataLoc.mountpoint}/.jotta-art-organizer/artwork-shards</code>.
          </li>
          <li className="py-0.5">
            For each file, open its <strong>Previous versions</strong> and download one from before the
            tags went missing. Dated before your first filing run is the one you want.
          </li>
          <li className="py-0.5">
            Hand them all over below at once — there are up to 256 of these files, and every one you give
            covers a different slice of the library. Handing over a few is fine; it simply restores fewer
            pictures.
          </li>
        </ol>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          multiple
          onChange={(e) => void read(e.target.files)}
          className="text-xs"
        />
        {busy && <span className="text-zinc-400">{busy}</span>}
      </div>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {plan && (
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <p>
            Read {plan.read.toLocaleString()} record{plan.read === 1 ? '' : 's'} out of {names.length} file
            {names.length === 1 ? '' : 's'}.{' '}
            {plan.pictures === 0 ? (
              <span className="text-zinc-500">
                Nothing to put back — the catalogue already has everything these hold.
              </span>
            ) : (
              <>
                <strong>{plan.tags.toLocaleString()}</strong> tag
                {plan.tags === 1 ? '' : 's'} could come back, across{' '}
                <strong>{plan.pictures.toLocaleString()}</strong> picture
                {plan.pictures === 1 ? '' : 's'}.
              </>
            )}
          </p>

          {plan.byCategory.length > 0 && (
            <p className="text-zinc-600 dark:text-zinc-400">
              {plan.byCategory
                .map(({ category, count }) => `${category}: ${count.toLocaleString()}`)
                .join(' · ')}
            </p>
          )}

          {plan.unknownPictures > 0 && (
            <p className="text-zinc-500">
              {plan.unknownPictures.toLocaleString()} of those pictures have no record at all in the
              catalogue now — those come back whole.
            </p>
          )}

          {plan.unreadable.length > 0 && (
            <ul className="text-amber-700 dark:text-amber-500">
              {plan.unreadable.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          )}

          {/* Shown before agreeing: a list of counts is not something anyone
              can check, and a title is exactly the kind of thing you would
              recognise as right or wrong at a glance. */}
          {plan.examples.length > 0 && (
            <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
              {plan.examples.map((e, i) => (
                <li key={`${e.md5}/${e.category}/${i}`}>
                  {e.path.split('/').pop() || e.md5} — {e.category}: {e.value}
                </li>
              ))}
            </ul>
          )}

          {restored === null ? (
            plan.upsert.length > 0 && (
              <button
                onClick={() => void apply()}
                disabled={busy !== null}
                className="mt-1 self-start rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Put back {plan.tags.toLocaleString()} tag{plan.tags === 1 ? '' : 's'}
              </button>
            )
          ) : (
            <p className="mt-1 text-emerald-700 dark:text-emerald-400">
              Put back into {restored.toLocaleString()} record{restored === 1 ? '' : 's'}. Hand over more
              versions to cover more of the library.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
