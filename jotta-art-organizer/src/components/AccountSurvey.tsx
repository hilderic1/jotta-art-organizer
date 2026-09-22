'use client'

import { useRef, useState } from 'react'
import { surveyAccount, type MountpointSurvey } from '@/lib/survey'

/**
 * Counts what every device and mountpoint holds, so "where are my pictures?"
 * is answered rather than browsed for.
 *
 * Files and pictures are reported separately on purpose: a mountpoint of
 * thousands of files and no pictures is a backup of something else, and a
 * mountpoint of thousands of pictures this app has never looked at is the
 * thing being hunted.
 */
export function AccountSurvey() {
  const [results, setResults] = useState<MountpointSurvey[] | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [name, setName] = useState('')
  const [searched, setSearched] = useState('')
  const [error, setError] = useState<string | null>(null)
  const stopper = useRef<AbortController | null>(null)

  async function run() {
    const controller = new AbortController()
    stopper.current = controller
    setRunning(true)
    setError(null)
    setResults(null)
    setSearched(name.trim())
    try {
      const out = await surveyAccount({
        nameContains: name.trim() || undefined,
        signal: controller.signal,
        onProgress: (done, total, current) => setProgress({ done, total, current }),
      })
      setResults(out)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not go through the account.')
    } finally {
      stopper.current = null
      setRunning(false)
      setProgress(null)
    }
  }

  const found = results?.flatMap((r) => r.matches.map((path) => ({ ...r, path }))) ?? []
  const blind = results?.filter((r) => r.withoutHash > 0 || r.unread > 0) ?? []

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Where the pictures are</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Goes through every device and mountpoint in your Jottacloud and counts what each one holds. One
        request per folder, so it takes a while on a big account — but it answers which mountpoint your
        photos are actually in, which is not something Jottacloud&rsquo;s Media view will tell you, since
        Media is a gallery over the whole account rather than a folder.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-zinc-500">Also find a file named</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="IMG-20260919-WA0043.jpg"
            className="w-56 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        {running ? (
          <button
            onClick={() => stopper.current?.abort()}
            className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={run}
            className="rounded bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500"
          >
            Count everything
          </button>
        )}
      </div>

      {progress && (
        <p className="mt-2 text-xs text-zinc-400">
          {progress.current || 'Finishing'} — mountpoint {progress.done + 1} of {progress.total}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {results && (
        <div className="mt-3 flex flex-col gap-3 text-xs">
          {/* The answer to the question that prompted this, when one was
              asked: not how many, but where. */}
          {searched && (
            <div>
              {found.length === 0 ? (
                <p className="text-amber-700 dark:text-amber-500">
                  No file with &ldquo;{searched}&rdquo; in its name anywhere in the account. If Jottacloud
                  shows it in Media, it is stored somewhere this listing cannot reach.
                </p>
              ) : (
                <div>
                  <p className="text-zinc-500">
                    &ldquo;{searched}&rdquo; found in {found.length} place{found.length === 1 ? '' : 's'}:
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    {found.map((f) => (
                      <li key={`${f.device}/${f.mountpoint}/${f.path}`}>
                        {f.device}/{f.mountpoint}/{f.path}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <table className="w-full text-left">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-2 font-normal">Device / mountpoint</th>
                <th className="py-1 pr-2 text-right font-normal">Folders</th>
                <th className="py-1 pr-2 text-right font-normal">Files</th>
                <th className="py-1 pr-2 text-right font-normal">Pictures</th>
                <th className="py-1 text-right font-normal">Unreadable</th>
              </tr>
            </thead>
            <tbody>
              {[...results]
                .sort((a, b) => b.pictures - a.pictures || b.files - a.files)
                .map((r) => (
                  <tr key={`${r.device}/${r.mountpoint}`} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="py-1 pr-2">
                      {r.device}/{r.mountpoint}
                      {r.error && <span className="block text-red-600 dark:text-red-400">{r.error}</span>}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.folders.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.files.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.pictures.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">
                      {r.withoutHash + r.unread > 0 ? (
                        <span className="text-red-600 dark:text-red-400">
                          {(r.withoutHash + r.unread).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-zinc-400">0</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>

          {blind.length > 0 && (
            <p className="rounded border border-red-300 bg-red-50 p-2 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              Files counted here that the rest of the app cannot see: either Jottacloud lists them without a
              checksum, or its own tally for a folder is higher than what arrived. Everywhere else in this
              app those files are invisible — a folder of them looks empty — so nothing should be removed or
              deduplicated until that is sorted out.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
