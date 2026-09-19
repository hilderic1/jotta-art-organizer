'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, type MountpointRef, type SessionStatus } from '@/lib/api'
import { LocationPicker } from '@/components/LocationPicker'
import { checkTakeout, type TakeoutCheckResult } from '@/lib/takeoutCheck'
import { GooglePhotosHandoff } from '@/components/GooglePhotosHandoff'

function day(epochSeconds: number | undefined): string {
  if (!epochSeconds) return 'unknown'
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export default function TakeoutCheckPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [folder, setFolder] = useState<(MountpointRef & { path?: string }) | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ stage: 'listing' | 'reading'; done: number; total: number } | null>(null)
  const [result, setResult] = useState<TakeoutCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  async function run(loc: MountpointRef & { path?: string }) {
    setFolder(loc)
    setRunning(true)
    setResult(null)
    setError(null)
    setProgress(null)
    try {
      const checked = await checkTakeout(
        { device: loc.device, mountpoint: loc.mountpoint },
        loc.path ?? '',
        (stage, done, total) => setProgress({ stage, done, total })
      )
      setResult(checked)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check failed.')
    } finally {
      setRunning(false)
    }
  }

  if (session === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }
  if (!session.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your Jottacloud account first.</p>
        <Link href="/setup" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  const folderLabel = folder ? (folder.path ? `${folder.mountpoint}/${folder.path}` : folder.mountpoint) : ''
  const safe = result && result.missing.length === 0 && result.incomplete.length === 0 && result.unreadable === 0

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Before deleting from Google Photos</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Checks that your Google Takeout export really arrived in Jottacloud, and tells you up to which date
          it&rsquo;s complete. Nothing is changed — here or in Google Photos. The deleting is yours to do, and
          this tells you what&rsquo;s safe.
        </p>
      </div>

      {!running && !result && (
        <>
          <p className="text-sm text-zinc-500">Choose the folder holding your Takeout export.</p>
          <LocationPicker onSelect={run} />
        </>
      )}

      {running && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600 dark:border-zinc-700 dark:border-t-indigo-500" />
          {progress?.stage === 'reading'
            ? `Reading Google's records — ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
            : `Listing ${folderLabel}${progress ? ` — ${progress.done} folders so far` : '…'}`}
        </div>
      )}

      {error && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <button onClick={() => folder && run(folder)} className="self-start text-sm text-indigo-600 hover:underline">
            Try again
          </button>
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500">
            Checked {result.photos.toLocaleString()} pictures and {result.records.toLocaleString()} of Google&rsquo;s
            records across {result.folders.toLocaleString()} folders in {folderLabel}.
          </p>

          {/* The cut-off leads: it's the one fact every deletion depends on. */}
          {result.latestUpload && (
            <div
              className={
                safe
                  ? 'rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
              }
            >
              <p>
                This export holds everything Google Photos had received up to{' '}
                <strong>{day(result.latestUpload)}</strong>
                {safe ? ', and all of it is here.' : ' — but not all of it is here. See below.'}
              </p>
              <p className="mt-1 text-xs">
                The pictures in it were taken between {day(result.earliestTaken)} and {day(result.latestTaken)}.
              </p>
            </div>
          )}

          {result.missing.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-red-700 dark:text-red-400">
                {result.missing.length.toLocaleString()} picture{result.missing.length === 1 ? '' : 's'} Google
                exported that aren&rsquo;t here — keep these in Google Photos
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Google&rsquo;s record is present but the picture beside it isn&rsquo;t, usually from an upload
                that failed partway. Search for each name in Google Photos and download it again before deleting.
              </p>
              <ul className="mt-2 max-h-64 overflow-y-auto text-xs">
                {result.missing.map((m, i) => (
                  <li key={`${m.folder}/${m.title}/${i}`} className="border-b border-zinc-100 py-1 dark:border-zinc-900">
                    <span className="font-medium">{m.title}</span>
                    <span className="text-zinc-500"> — taken {day(m.takenAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.incomplete.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-red-700 dark:text-red-400">
                {result.incomplete.length.toLocaleString()} picture{result.incomplete.length === 1 ? '' : 's'} whose
                upload to Jottacloud never finished
              </h2>
              <ul className="mt-2 max-h-48 overflow-y-auto text-xs">
                {result.incomplete.map((m, i) => (
                  <li key={`${m.folder}/${m.name}/${i}`} className="py-0.5">
                    {m.name} <span className="text-zinc-500">({m.state.toLowerCase()})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.unreadable > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-500">
              {result.unreadable.toLocaleString()} of Google&rsquo;s records couldn&rsquo;t be read, so this
              check can&rsquo;t vouch for those pictures. Running it again usually clears this.
            </p>
          )}

          {/* The easy route: only photos confirmed safe here are ever ticked, so
              anything Google received after the export is left alone without
              you having to find it. */}
          <GooglePhotosHandoff archived={result.archived} />

          {/* The part no check can do from here: Google may have received
              photos after the export, and the website sorts them among the
              old dates by when they were taken. */}
          {result.latestUpload && (
            <section className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <h2 className="font-medium">Or, deleting by date range yourself</h2>
              <ol className="mt-2 list-decimal pl-5 text-xs text-zinc-600 dark:text-zinc-400">
                <li className="py-0.5">
                  In Google Photos, search for <strong>Recently added</strong>. Anything added after{' '}
                  {day(result.latestUpload)} was never exported — it&rsquo;s only in Google.
                </li>
                <li className="py-0.5">
                  Note the dates those were <em>taken</em>. The website files them among the old dates, so a
                  range you delete could include one.
                </li>
                <li className="py-0.5">
                  Delete date ranges that avoid those days — or run a fresh Takeout first, bring it across, and
                  check again.
                </li>
                <li className="py-0.5">
                  Delete on the website, not in the Google Photos app on the iPad, which can offer to delete the
                  iPad&rsquo;s own copy too.
                </li>
              </ol>
            </section>
          )}

          <button
            onClick={() => {
              setResult(null)
              setFolder(null)
            }}
            className="self-start text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Check a different folder
          </button>
        </div>
      )}
    </div>
  )
}
