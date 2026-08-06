'use client'

import { useEffect, useRef, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { Thumbnail } from './Thumbnail'
import {
  loadIntakeConfig,
  scanIntake,
  fileIntake,
  type IntakeConfig,
  type IntakeMatch,
} from '@/lib/photoIntake'

/**
 * Offers to file new PicsArt and AI-made pictures out of the iPad's backup.
 *
 * Runs when the app opens, because that's the only moment a web app gets —
 * there's no background on iOS. It never files anything on its own: a wrong
 * guess that has already copied a picture somewhere is far more annoying to
 * undo than one that asked first.
 */
export function IntakeBanner({ metadataLoc }: { metadataLoc: MountpointRef }) {
  const [config, setConfig] = useState<IntakeConfig | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [matches, setMatches] = useState<IntakeMatch[] | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [showList, setShowList] = useState(false)
  const [filing, setFiling] = useState(false)
  const [filed, setFiled] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // React runs effects twice in development; a scan is expensive enough that
  // doing it once matters even there.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let ignore = false

    loadIntakeConfig(metadataLoc)
      .then((loaded) => {
        if (ignore || !loaded?.enabled) return
        setConfig(loaded)
        setScanning(true)
        return scanIntake(metadataLoc, loaded, {
          onProgress: (done, total) => {
            if (!ignore) setProgress({ done, total })
          },
        })
          .then((scan) => {
            if (ignore) return
            setMatches(scan.matches)
            setRemaining(scan.remaining)
          })
          .catch((err) => {
            if (!ignore) setError(err instanceof Error ? err.message : 'Could not look for new pictures.')
          })
          .finally(() => {
            if (!ignore) setScanning(false)
          })
      })
      .catch(() => {
        // No configuration, or it couldn't be read: the rest of the app is
        // unaffected, so this stays quiet rather than raising an error about
        // a feature that may never have been set up.
      })

    return () => {
      ignore = true
    }
  }, [metadataLoc])

  async function handleFile() {
    if (!config || !matches) return
    setFiling(true)
    setError(null)
    try {
      const result = await fileIntake(config, matches)
      setFiled(result.copied)
      setMatches(null)
      if (result.failed.length > 0) {
        setError(`${result.failed.length} could not be copied: ${result.failed[0].error}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Filing failed.')
    } finally {
      setFiling(false)
    }
  }

  if (dismissed || !config) return null

  // Quiet while it works: this runs on every start, and a spinner shouting
  // about a background errand every time you open the app would wear thin.
  if (scanning) {
    return (
      <p className="text-xs text-zinc-400">
        Looking for new pictures in {config.source.path || config.source.mountpoint}
        {progress && progress.total > 0 ? ` — ${progress.done} of ${progress.total} checked` : '…'}
      </p>
    )
  }

  if (filed !== null) {
    return (
      <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        Filed {filed} picture{filed === 1 ? '' : 's'} into {config.dest.path || config.dest.mountpoint}.
        {error && <span className="block text-xs">{error}</span>}
      </div>
    )
  }

  if (error && !matches) {
    return <p className="text-xs text-amber-700 dark:text-amber-500">{error}</p>
  }

  if (!matches || matches.length === 0) return null

  const sourceLoc = { device: config.source.device, mountpoint: config.source.mountpoint }

  return (
    <div className="flex flex-col gap-2 rounded border border-indigo-300 bg-indigo-50 p-3 text-sm dark:border-indigo-800 dark:bg-indigo-950">
      <div className="flex items-start justify-between gap-2">
        <p>
          <strong>{matches.length}</strong> new picture{matches.length === 1 ? '' : 's'} from{' '}
          {config.source.path || config.source.mountpoint} look{matches.length === 1 ? 's' : ''} like your
          work.
          {remaining > 0 && (
            <span className="block text-xs text-zinc-500">
              {remaining} more still to check — they&rsquo;ll be looked at next time you open the app.
            </span>
          )}
        </p>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          aria-label="Not now"
          title="Not now"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleFile}
          disabled={filing}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {filing ? 'Copying…' : `Copy to ${config.dest.path || config.dest.mountpoint}`}
        </button>
        <button
          onClick={() => setShowList((v) => !v)}
          className="text-xs text-indigo-700 hover:underline dark:text-indigo-300"
        >
          {showList ? 'Hide them' : 'Show me'}
        </button>
      </div>

      {/* Each with what gave it away, so a photograph caught by mistake can be
          seen for what it is before anything is copied. */}
      {showList && (
        <ul className="max-h-64 overflow-y-auto">
          {matches.map((m) => (
            <li key={m.md5} className="flex items-center gap-2 py-1">
              <Thumbnail loc={sourceLoc} path={m.path} alt={m.name} px={64} className="h-8 w-8 shrink-0 rounded object-cover" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{m.name}</span>
                <span className="block truncate text-[11px] text-zinc-500">{m.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
