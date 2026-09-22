'use client'

import { useRef, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import { findOrphanSidecars, reuniteOrphans, type Orphan, type ReuniteReport } from '@/lib/reunite'

/**
 * Puts back together what filing separated: a Google Photos sidecar whose
 * picture has been moved into the artwork folder.
 *
 * Two steps on purpose. Finding the orphans is reading; deciding which
 * picture each belongs to is a judgement that can go wrong, so it shows what
 * it would write before writing anything.
 */
export function ReuniteSidecars({
  metadataLoc,
  exportLoc,
  exportPath,
}: {
  metadataLoc: MountpointRef
  exportLoc: MountpointRef
  exportPath: string
}) {
  const [orphans, setOrphans] = useState<Orphan[] | null>(null)
  const [dest, setDest] = useState<(MountpointRef & { path: string }) | null>(null)
  const [picking, setPicking] = useState(false)
  const [report, setReport] = useState<ReuniteReport | null>(null)
  const [written, setWritten] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopper = useRef<AbortController | null>(null)

  async function find() {
    const controller = new AbortController()
    stopper.current = controller
    setBusy('Going through the export…')
    setError(null)
    setOrphans(null)
    setReport(null)
    setWritten(false)
    try {
      const found = await findOrphanSidecars(exportLoc, exportPath, {
        signal: controller.signal,
        onProgress: (folders, n) => setBusy(`${folders} folders read — ${n} sidecars with no picture`),
      })
      setOrphans(found.orphans)
      if (found.orphans.length === 0) {
        setError(
          `Nothing to put back: all ${found.sidecarsSeen.toLocaleString()} sidecars still have their picture beside them.`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the export.')
    } finally {
      stopper.current = null
      setBusy(null)
    }
  }

  async function run(dryRun: boolean) {
    if (!orphans || !dest) return
    const controller = new AbortController()
    stopper.current = controller
    setBusy(dryRun ? 'Working out which picture each belongs to…' : 'Writing what the sidecars say…')
    setError(null)
    try {
      const out = await reuniteOrphans(metadataLoc, exportLoc, orphans, dest, dest.path, {
        dryRun,
        signal: controller.signal,
        onProgress: (done, total) =>
          setBusy(`${dryRun ? 'Matching' : 'Writing'} — ${done} of ${total}`),
      })
      setReport(out)
      setWritten(!dryRun)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not match them up.')
    } finally {
      stopper.current = null
      setBusy(null)
    }
  }

  const confirmed = report?.matched.filter((m) => m.confirmed) ?? []
  const doubtful = report?.matched.filter((m) => !m.confirmed) ?? []

  return (
    <section className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <h2 className="font-medium">Sidecars left behind</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Google keeps each picture&rsquo;s date, place and people in a JSON file beside it, paired by
        filename. Moving a picture into your artwork folder leaves that file here, and neither half can
        find the other afterwards. Nothing needs moving back — what the sidecar says only has to be read
        once, after which it belongs to the picture&rsquo;s content wherever that content lives.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={find}
          disabled={busy !== null}
          className="rounded border border-zinc-300 px-2 py-1 font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Find sidecars with no picture
        </button>
        {busy && <span className="text-zinc-400">{busy}</span>}
        {busy && (
          <button onClick={() => stopper.current?.abort()} className="text-zinc-600 dark:text-zinc-400">
            Stop
          </button>
        )}
      </div>

      {orphans && orphans.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          <p>
            <strong>{orphans.length.toLocaleString()}</strong> sidecar
            {orphans.length === 1 ? '' : 's'} whose picture is no longer beside{' '}
            {orphans.length === 1 ? 'it' : 'them'}.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-500">
              Where the pictures went: <strong>{dest ? `${dest.mountpoint}/${dest.path}` : 'not set'}</strong>
            </span>
            <button
              onClick={() => setPicking((v) => !v)}
              className="text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {picking ? 'Cancel' : 'Choose'}
            </button>
          </div>
          {picking && (
            <LocationPicker
              onSelect={(loc) => {
                setDest({ device: loc.device, mountpoint: loc.mountpoint, path: loc.path ?? '' })
                setPicking(false)
                setReport(null)
              }}
            />
          )}

          {dest && (
            <div className="flex flex-wrap gap-2">
              {/* Always a look first. This is the step where a wrong name
                  match would put one photograph's date and place onto
                  another, so it shows its working before writing. */}
              <button
                onClick={() => run(true)}
                disabled={busy !== null}
                className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Show me what it would do
              </button>
              {confirmed.length > 0 && !written && (
                <button
                  onClick={() => run(false)}
                  disabled={busy !== null}
                  className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Describe the {confirmed.length.toLocaleString()} confirmed
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {report && (
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <p>
            {written ? (
              <>
                <strong>{report.described.toLocaleString()}</strong> picture
                {report.described === 1 ? '' : 's'} described from their sidecars. Tags are held against
                the picture&rsquo;s content, so every copy of it has them now.
              </>
            ) : (
              <>
                <strong>{confirmed.length.toLocaleString()}</strong> can be matched with confidence —
                the name matches and the picture&rsquo;s own capture time agrees with the sidecar&rsquo;s.
              </>
            )}
          </p>
          {doubtful.length > 0 && (
            <p className="text-amber-700 dark:text-amber-500">
              {doubtful.length.toLocaleString()} matched by name alone and will be left alone. An export is
              full of repeated filenames, and one picture wearing another&rsquo;s date and place is worse
              than one with no date.
            </p>
          )}
          {report.unmatched > 0 && (
            <p className="text-zinc-500">
              {report.unmatched.toLocaleString()} had no picture of that name in{' '}
              {dest ? `${dest.mountpoint}/${dest.path}` : 'the artwork folder'} — they may have gone
              somewhere else, or never been filed at all.
            </p>
          )}
          {report.matched.length > 0 && (
            <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto font-mono text-[11px]">
              {report.matched.slice(0, 50).map((m) => (
                <li key={m.orphan.sidecar.path} className={m.confirmed ? 'text-zinc-500' : 'text-amber-700 dark:text-amber-500'}>
                  {m.orphan.pictureName} → {m.picture.path} ({m.why})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-zinc-500">{error}</p>}
    </section>
  )
}
