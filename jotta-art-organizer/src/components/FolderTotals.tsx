'use client'

import { useRef, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { surveyFolder, type FolderSurvey } from '@/lib/survey'

/**
 * Totals for a folder and everything below it.
 *
 * A folder listing only ever reports what's directly in a folder, which reads
 * as a total and isn't one — a subfolder holding more than its parent then
 * looks like a fault rather than the ordinary shape of a Google Photos
 * export. This counts the whole tree instead.
 */
export function FolderTotals({ loc, path }: { loc: MountpointRef; path: string }) {
  const [result, setResult] = useState<FolderSurvey | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ folders: number; files: number; stage: string } | null>(null)
  const [withArtwork, setWithArtwork] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stopper = useRef<AbortController | null>(null)

  const label = path ? `${loc.mountpoint}/${path}` : loc.mountpoint

  async function run() {
    const controller = new AbortController()
    stopper.current = controller
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(
        await surveyFolder(loc, path, {
          detectArtwork: withArtwork,
          signal: controller.signal,
          onProgress: (folders, files, stage) => setProgress({ folders, files, stage }),
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not count that folder.')
    } finally {
      stopper.current = null
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <div className="rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
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
            className="rounded border border-zinc-300 px-2 py-1 font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Count everything below {label}
          </button>
        )}
        {/* Off by default, and labelled with what it costs: this is one
            request per picture against one per folder for the rest. */}
        <label className="flex items-center gap-1 text-zinc-500">
          <input
            type="checkbox"
            checked={withArtwork}
            disabled={running}
            onChange={(e) => setWithArtwork(e.target.checked)}
          />
          also read each picture to count artwork (slow)
        </label>
      </div>

      {progress && (
        <p className="mt-1 text-zinc-400">
          {progress.stage === 'reading'
            ? `Reading pictures — ${progress.files.toLocaleString()} so far`
            : `${progress.folders.toLocaleString()} folders, ${progress.files.toLocaleString()} files so far`}
        </p>
      )}
      {error && <p className="mt-1 text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-1 text-zinc-600 dark:text-zinc-400">
          <p>
            <strong>{result.files.toLocaleString()}</strong> file
            {result.files === 1 ? '' : 's'} in{' '}
            <strong>{result.folders.toLocaleString()}</strong> folder
            {result.folders === 1 ? '' : 's'}, {result.deepest} level
            {result.deepest === 1 ? '' : 's'} deep. <strong>{result.pictures.toLocaleString()}</strong> of
            the files are pictures.
            {result.artwork != null && (
              <>
                {' '}
                <strong>{result.artwork.toLocaleString()}</strong> of them say they were made by PicsArt or
                an AI tool
                {result.artworkRead != null && result.artworkRead < result.pictures
                  ? ` — out of ${result.artworkRead.toLocaleString()} read before this stopped`
                  : ''}
                .
              </>
            )}
          </p>
          {(result.withoutHash > 0 || result.unread > 0) && (
            <p className="mt-1 rounded border border-red-300 bg-red-50 p-2 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {result.withoutHash > 0 &&
                `${result.withoutHash.toLocaleString()} of those files have no checksum, so the rest of this app cannot see them. `}
              {result.unread > 0 &&
                `${result.unread.toLocaleString()} entries Jottacloud reported never arrived. `}
              Counts elsewhere in the app are short by at least that much.
            </p>
          )}
          {result.error && <p className="mt-1 text-amber-700 dark:text-amber-500">{result.error}</p>}
        </div>
      )}
    </div>
  )
}
