'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { MountpointRef } from '@/lib/api'
import { Thumbnail } from './Thumbnail'
import { ImageViewer } from './ImageViewer'
import {
  loadIntakeConfig,
  scanIntake,
  fileIntake,
  rememberNotArtwork,
  removeStrays,
  appendIntakeLog,
  summariseRun,
  runLabel,
  runNeeds,
  type IntakeConfig,
  type IntakeMatch,
  type IntakeLogEntry,
} from '@/lib/photoIntake'
import { describeArrivedFiles } from '@/lib/autoDescribe'

// Whether this visit to the app has already looked. Deliberately outside the
// component: the banner only exists on the Catalogue's folder-picking screen,
// so choosing a folder takes it away and coming back builds it anew. Without
// this, every return to that screen would set another full walk of both
// folder trees going.
let lookedThisVisit = false
// What that look found, kept for the same reason: the screen it was reported
// on is gone the moment a folder is chosen.
let lastRun: IntakeLogEntry | null = null

/**
 * Offers to file new PicsArt and AI-made pictures out of the iPad's backup.
 *
 * Runs when the app opens, because that's the only moment a web app gets —
 * there's no background on iOS. It never files anything on its own: a wrong
 * guess that has already copied a picture somewhere is far more annoying to
 * undo than one that asked first.
 */
export function IntakeBanner({
  metadataLoc,
  whenSettled,
}: {
  metadataLoc: MountpointRef
  /** Shown only once the banner has nothing running and nothing waiting on
   *  you. The Catalogue passes its folder picker, because choosing a folder
   *  takes this screen away and calls off whatever was in progress. */
  whenSettled?: ReactNode
}) {
  const [config, setConfig] = useState<IntakeConfig | null>(null)
  const [scanning, setScanning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [run, setRun] = useState<IntakeLogEntry | null>(lastRun)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [matches, setMatches] = useState<IntakeMatch[] | null>(null)
  const [strays, setStrays] = useState<IntakeMatch[]>([])
  const [remaining, setRemaining] = useState(0)
  const [showList, setShowList] = useState(false)
  // Held as what's been turned *off*, so a match found by a later scan
  // arrives selected rather than silently skipped.
  const [deselected, setDeselected] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<IntakeMatch | null>(null)
  const [filing, setFiling] = useState(false)
  const [confirmingMove, setConfirmingMove] = useState(false)
  const [confirmingStrays, setConfirmingStrays] = useState(false)
  const [tidying, setTidying] = useState<{ done: number; total: number } | null>(null)
  const [tidied, setTidied] = useState<number | null>(null)
  const [describing, setDescribing] = useState<{ done: number; total: number } | null>(null)
  const [filed, setFiled] = useState<number | null>(null)
  const [removedCount, setRemovedCount] = useState(0)
  const [described, setDescribed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const alive = useRef(true)
  // Held so the Skip button — and leaving the screen — can actually call the
  // walk off rather than only stop listening to it.
  const stopper = useRef<AbortController | null>(null)

  const runScan = useCallback(
    async (loaded: IntakeConfig) => {
      lookedThisVisit = true
      const controller = new AbortController()
      stopper.current = controller
      setStopping(false)
      setScanning(true)
      setError(null)
      setFiled(null)
      setTidied(null)
      setDismissed(false)
      try {
        const scan = await scanIntake(metadataLoc, loaded, {
          signal: controller.signal,
          onProgress: (done, total) => {
            if (alive.current) setProgress({ done, total })
          },
        })
        lastRun = scan.logged
        if (!alive.current) return
        setRun(scan.logged)
        // Half a look is not an answer, so a stopped scan leaves the offer
        // empty rather than presenting what it happened to reach as the lot.
        if (scan.stopped) {
          setMatches(null)
          setStrays([])
          return
        }
        setMatches(scan.matches)
        setStrays(scan.strays)
        setRemaining(scan.remaining)
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : 'Could not look for new artwork.')
      } finally {
        if (stopper.current === controller) stopper.current = null
        if (alive.current) {
          setScanning(false)
          setStopping(false)
        }
      }
    },
    [metadataLoc]
  )

  useEffect(() => {
    alive.current = true
    let cancelled = false
    loadIntakeConfig(metadataLoc)
      .then((loaded) => {
        if (cancelled || !alive.current || !loaded) return
        // Kept whether or not it looks: the switch governs looking on its
        // own, while asking for a look is always allowed.
        setConfig(loaded)
        if (loaded.enabled && !lookedThisVisit) return runScan(loaded)
      })
      .catch(() => {
        // No configuration, or it couldn't be read: the rest of the app is
        // unaffected, so this stays quiet rather than raising an error about
        // a feature that may never have been set up.
      })

    return () => {
      cancelled = true
      alive.current = false
      // Choosing a folder takes this screen away, and a walk nobody is
      // waiting on is a walk competing with the catalogue for every request.
      stopper.current?.abort()
      stopper.current = null
    }
  }, [metadataLoc, runScan])

  // Recorded in the account, not just this session: the point of "never" is
  // that the next scan doesn't even read this file's header again.
  async function neverAgain(match: IntakeMatch) {
    setMatches((prev) => prev?.filter((m) => m.md5 !== match.md5) ?? null)
    try {
      await rememberNotArtwork(metadataLoc, [match.md5])
    } catch {
      // It'll simply be offered again next time — annoying, not harmful, and
      // not worth an error over a picture already off the screen.
    }
  }

  // Written to the account, and kept on screen: the line is the receipt for
  // work that copied, removed and described files, and the screen it appears
  // on can be gone a moment later.
  async function recordRun(entry: IntakeLogEntry) {
    lastRun = entry
    if (alive.current) setRun(entry)
    try {
      await appendIntakeLog(metadataLoc, entry)
    } catch {
      // A missing line in the log doesn't undo any of the work it describes.
    }
  }

  function toggle(md5: string) {
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(md5)) next.delete(md5)
      else next.add(md5)
      return next
    })
  }

  async function handleFile() {
    if (!config || !matches) return
    // Anything left unticked stays where it is. It isn't recorded as "not
    // artwork" either, so it comes back next time rather than being written
    // off on the strength of one glance.
    const chosen = matches.filter((m) => !deselected.has(m.md5))
    if (chosen.length === 0) return
    setFiling(true)
    setConfirmingMove(false)
    setError(null)
    let describedNow = 0
    try {
      const result = await fileIntake(config, chosen)
      setFiled(result.copied)
      setRemovedCount(result.removed)
      setMatches(null)
      if (result.failed.length > 0) {
        setError(`${result.failed.length} could not be copied: ${result.failed[0].error}`)
      } else if (result.removeFailed.length > 0) {
        setError(
          `${result.removeFailed.length} filed, but stayed in ${config.source.path || config.source.mountpoint}: ${result.removeFailed[0].error}`
        )
      }
      // A picture nobody has read is invisible to the catalogue — not
      // findable by date, place or camera — so reading it is part of filing
      // it, not a separate errand to remember afterwards.
      if (result.copiedPaths.length > 0) {
        const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }
        try {
          const outcome = await describeArrivedFiles(
            metadataLoc,
            destLoc,
            config.dest.path,
            result.copiedPaths,
            { onProgress: (done, total) => setDescribing({ done, total }) }
          )
          describedNow = outcome.described
          setDescribed(outcome.described)
        } catch {
          // The copies are safely in place; describing them is what the
          // catalogue's own bulk import does anyway, so a failure here is
          // worth no alarm of its own.
        } finally {
          setDescribing(null)
        }
      }
      await recordRun({
        at: new Date().toISOString(),
        kind: 'file',
        filed: result.copied,
        removed: result.removed,
        described: describedNow,
        failed: result.failed.length + result.removeFailed.length,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Filing failed.')
    } finally {
      setFiling(false)
    }
  }

  // The backlog: pictures already in the artwork folder that earlier copying
  // left sitting among the photographs. Nothing is copied here — the content
  // is demonstrably already filed, so this only takes the spare out.
  async function handleTidy() {
    if (!config || strays.length === 0) return
    setConfirmingStrays(false)
    setError(null)
    setTidying({ done: 0, total: strays.length })
    try {
      const result = await removeStrays(config, strays, {
        onProgress: (done, total) => setTidying({ done, total }),
      })
      setTidied(result.removed)
      setStrays([])
      await recordRun({
        at: new Date().toISOString(),
        kind: 'tidy',
        removed: result.removed,
        failed: result.failed.length,
      })
      if (result.failed.length > 0) {
        setError(`${result.failed.length} could not be removed: ${result.failed[0].error}`)
      } else if (result.unconfirmed > 0) {
        // Left alone on purpose: the copy in the artwork folder wasn't there
        // on the second look, and a picture that exists in one place only is
        // not a spare.
        setError(
          `${result.unconfirmed} left where they are — no copy of them was found in ${config.dest.path || config.dest.mountpoint} just now.`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not tidy the photo folder.')
    } finally {
      setTidying(null)
    }
  }

  // Busy means: looking, working, or holding a decision that hasn't been
  // made. Whatever the page hands over as `whenSettled` is kept back until
  // this is false — on the Catalogue that's the folder picker, and taking it
  // mid-look used to call the look off without ever saying so.
  const showingResult = filed !== null || tidied !== null
  const busy =
    scanning ||
    stopping ||
    filing ||
    tidying !== null ||
    (!dismissed && !showingResult && ((matches?.length ?? 0) > 0 || strays.length > 0))

  const body = renderBody()
  return (
    <>
      {body}
      {!busy && whenSettled}
    </>
  )

  function renderBody() {
    if (!config) return null

    const sourceName = config.source.path || config.source.mountpoint
    const destName = config.dest.path || config.dest.mountpoint
    const moving = config.mode === 'move'

    // Asking for a look is always available, even when a scan found nothing and
    // even after dismissing one — "a function in the app" rather than something
    // that only happens to you when the app opens.
    const lookAgain = (
      <button
        onClick={() => void runScan(config)}
        disabled={scanning || filing || tidying !== null}
        className="text-xs text-indigo-700 hover:underline disabled:opacity-50 dark:text-indigo-300"
      >
        Look for new artwork now
      </button>
    )

    // What the last run did, rather than a button with nothing to say. Without
    // this a finished look is indistinguishable from one that never ran.
    const followUp = run && runNeeds(run)
    const lastRunLine = run && (
      <span className="text-xs text-zinc-500">
        {/* Named in full for a look, because "did it go into the subfolders?"
            is otherwise unanswerable from the screen — and the answer is yes. */}
        {run.kind === 'look'
          ? `Looked through ${sourceName} and everything below it`
          : runLabel(run.kind)}{' '}
        — {summariseRun(run)}.{' '}
        <span className="text-zinc-400">
          {new Date(run.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        {/* Counts alone read as a task whose instructions went missing. This
            says whether anything is actually left, and where to do it. */}
        {followUp && (
          <span className="block">
            {followUp.what}
            {followUp.where === 'setup' && (
              <>
                {' '}
                <Link href="/setup" className="text-indigo-700 hover:underline dark:text-indigo-300">
                  Filing new artwork, in Setup
                </Link>
              </>
            )}
          </span>
        )}
      </span>
    )

    if (dismissed) {
      return (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-zinc-400">
          {lastRunLine}
          {lookAgain}
        </p>
      )
    }

    // Quiet while it works: this runs on every start, and a spinner shouting
    // about a background errand every time you open the app would wear thin.
    // Skipping is a button rather than something you do by leaving the screen:
    // the walk is long enough to sit through, and choosing a folder to get past
    // it used to abandon the look without ever saying so.
    if (scanning) {
      return (
        <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span>
            Looking for new artwork in {sourceName}
            {progress && progress.total > 0 ? ` — ${progress.done} of ${progress.total} checked` : '…'}
          </span>
          <button
            onClick={() => {
              setStopping(true)
              stopper.current?.abort()
            }}
            disabled={stopping}
            className="text-indigo-700 hover:underline disabled:opacity-50 dark:text-indigo-300"
          >
            {/* Requests already sent still have to come back, so this says what
                is happening rather than appearing to hang. */}
            {stopping ? 'Stopping…' : 'Skip for now'}
          </button>
        </p>
      )
    }

    if (tidying) {
      return (
        <p className="text-xs text-zinc-400">
          Taking pictures already filed out of {sourceName} — {tidying.done} of {tidying.total}
        </p>
      )
    }

    if (tidied !== null) {
      return (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Took {tidied} picture{tidied === 1 ? '' : 's'} out of {sourceName}. They were already in {destName};
          the copies that were in with your photographs are now in Jottacloud&rsquo;s trash.
          {error && <span className="block text-xs">{error}</span>}
          <span className="mt-1 block">{lookAgain}</span>
        </div>
      )
    }

    if (filed !== null) {
      return (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Filed {filed} picture{filed === 1 ? '' : 's'} into {destName}.
          {removedCount > 0 && (
            <span className="block text-xs">
              {removedCount} taken out of {sourceName} — in Jottacloud&rsquo;s trash if you want them back.
            </span>
          )}
          {describing && (
            <span className="block text-xs">
              Reading what they say about themselves — {describing.done} of {describing.total}
            </span>
          )}
          {!describing && described > 0 && (
            <span className="block text-xs">
              {described} of them described from what the file says — ready to find by date, place or camera.
            </span>
          )}
          {error && <span className="block text-xs">{error}</span>}
          <span className="mt-1 block">{lookAgain}</span>
        </div>
      )
    }

    if (error && !matches) {
      return (
        <p className="text-xs text-amber-700 dark:text-amber-500">
          {error} <span className="ml-1">{lookAgain}</span>
        </p>
      )
    }

    const nothingNew = !matches || matches.length === 0

    // Nothing new, but the photo folder still holds pictures that are already
    // filed. On its own this is the whole point of moving: the folders only
    // stay separate if what earlier copying left behind is cleared out too.
    if (nothingNew && strays.length > 0) {
      return (
        <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p>
            <strong>{strays.length.toLocaleString()}</strong> picture
            {strays.length === 1 ? ' is' : 's are'} already in {destName} but still sitting in {sourceName}.
            <span className="block text-xs text-zinc-500">
              Copies left behind before filing started moving them. Taking them out is what keeps your work
              separate from your photographs.
            </span>
          </p>
          {confirmingStrays ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleTidy}
                className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
              >
                Yes, take {strays.length.toLocaleString()} out of {sourceName}
              </button>
              <button
                onClick={() => setConfirmingStrays(false)}
                className="px-2 text-sm text-zinc-600 dark:text-zinc-400"
              >
                Cancel
              </button>
              <span className="text-xs text-zinc-500">
                Each one is checked against {destName} again first, and goes to Jottacloud&rsquo;s trash.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setConfirmingStrays(true)}
                className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
              >
                Take them out of {sourceName}
              </button>
              {lookAgain}
            </div>
          )}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )
    }

    if (nothingNew) {
      return (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-zinc-400">
          {lastRunLine}
          {lookAgain}
        </p>
      )
    }

    const sourceLoc = { device: config.source.device, mountpoint: config.source.mountpoint }
    const chosenCount = matches.filter((m) => !deselected.has(m.md5)).length

    return (
      <div className="flex flex-col gap-2 rounded border border-indigo-300 bg-indigo-50 p-3 text-sm dark:border-indigo-800 dark:bg-indigo-950">
        <div className="flex items-start justify-between gap-2">
          <p>
            <strong>{matches.length}</strong> new picture{matches.length === 1 ? '' : 's'} from {sourceName}{' '}
            look{matches.length === 1 ? 's' : ''} like your work.
            {remaining > 0 && (
              <span className="block text-xs text-zinc-500">
                {remaining} more still to check — they&rsquo;ll be looked at next time you open the app.
              </span>
            )}
            {strays.length > 0 && (
              <span className="block text-xs text-zinc-500">
                {strays.length.toLocaleString()} more are already in {destName} but still sitting here — file
                these first and they&rsquo;ll be offered next.
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

        {/* Moving is confirmed separately, because it's the one that takes
            something away: a wrong guess copied is clutter, a wrong guess moved
            is a photograph gone from where you expect it. */}
        {confirmingMove ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleFile}
              disabled={filing}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {filing ? 'Moving…' : `Yes, move ${chosenCount} out of ${sourceName}`}
            </button>
            <button
              onClick={() => setConfirmingMove(false)}
              className="px-2 text-sm text-zinc-600 dark:text-zinc-400"
            >
              Cancel
            </button>
            <span className="text-xs text-zinc-500">
              Each is copied first and only removed once that copy has succeeded. Removed pictures go to
              Jottacloud&rsquo;s trash.
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => (moving ? setConfirmingMove(true) : handleFile())}
              disabled={filing || chosenCount === 0}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {filing
                ? 'Copying…'
                : chosenCount === matches.length
                  ? `${moving ? 'Move' : 'Copy'} to ${destName}`
                  : `${moving ? 'Move' : 'Copy'} ${chosenCount} to ${destName}`}
            </button>
            <button
              onClick={() => setShowList((v) => !v)}
              className="text-xs text-indigo-700 hover:underline dark:text-indigo-300"
            >
              {showList ? 'Hide them' : 'Show me'}
            </button>
          </div>
        )}

        {/* Each with what gave it away, so a photograph caught by mistake can be
            seen for what it is before anything is copied. */}
        {showList && (
          <ul className="max-h-64 overflow-y-auto">
            {matches.map((m) => (
              <li key={m.md5} className="flex items-center gap-2 py-1">
                {/* Ticked by default — everything here matched — but a
                    photograph caught by mistake can be dropped rather than
                    forcing all or nothing. */}
                <input
                  type="checkbox"
                  checked={!deselected.has(m.md5)}
                  onChange={() => toggle(m.md5)}
                  aria-label={`Copy ${m.name}`}
                  className="shrink-0"
                />
                {/* The picture itself settles it faster than any label can,
                    so the thumbnail opens it full size with what the file
                    says beside it. */}
                <button onClick={() => setViewing(m)} className="shrink-0" title={`Open ${m.name}`}>
                  <Thumbnail loc={sourceLoc} path={m.path} alt={m.name} px={64} className="h-8 w-8 shrink-0 rounded object-cover" />
                </button>
                <button onClick={() => setViewing(m)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs">{m.name}</span>
                  <span className="block truncate text-[11px] text-zinc-500">{m.reason}</span>
                </button>
                {/* Unticking is "not this time"; this is "stop asking". Both
                    are wanted — one for a piece you're not ready to file, one
                    for a picture that will never be your work. */}
                <button
                  onClick={() => neverAgain(m)}
                  className="shrink-0 text-[11px] text-zinc-500 hover:text-red-600 hover:underline dark:hover:text-red-400"
                  title="Don't offer this picture again"
                >
                  Never
                </button>
              </li>
            ))}
          </ul>
        )}

        {viewing && (
          <ImageViewer
            loc={sourceLoc}
            path={viewing.path}
            title={viewing.name}
            onClose={() => setViewing(null)}
          />
        )}

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    )
  }
}
