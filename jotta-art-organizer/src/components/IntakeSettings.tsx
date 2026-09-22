'use client'

import { useEffect, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import {
  loadIntakeConfig,
  saveIntakeConfig,
  countNotArtwork,
  forgetNotArtwork,
  loadIntakeLog,
  appendIntakeLog,
  summariseRun,
  runLabel,
  runNeeds,
  findLeftovers,
  removeEmptyFolders,
  pruneSetAside,
  type Leftovers,
  type FolderRef,
  type IntakeConfig,
  type IntakeLogEntry,
} from '@/lib/photoIntake'

function label(folder: FolderRef | null): string {
  if (!folder) return 'not set'
  return folder.path ? `${folder.mountpoint}/${folder.path}` : folder.mountpoint
}

/**
 * Where new artwork and photos arrive, and where her work is kept.
 *
 * Two folders and a switch. It lives in Setup rather than the Catalogue
 * because it's set once and then forgotten — the Catalogue only acts on it.
 */
export function IntakeSettings({ metadataLoc }: { metadataLoc: MountpointRef }) {
  const [config, setConfig] = useState<IntakeConfig | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [picking, setPicking] = useState<'source' | 'dest' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setAside, setSetAside] = useState(0)
  const [forgetting, setForgetting] = useState(false)
  const [runs, setRuns] = useState<IntakeLogEntry[]>([])
  const [showRuns, setShowRuns] = useState(false)
  const [leftovers, setLeftovers] = useState<Leftovers | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirmingFolders, setConfirmingFolders] = useState(false)
  // One line saying what's happening, rather than a flag per job: only one of
  // these runs at a time, and they're all "wait, it's working".
  const [working, setWorking] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    loadIntakeConfig(metadataLoc)
      .then((stored) => {
        if (ignore) return
        setConfig(stored)
        setLoaded(true)
      })
      .then(() => countNotArtwork(metadataLoc))
      .then((count) => {
        if (!ignore) setSetAside(count)
      })
      .then(() => loadIntakeLog(metadataLoc))
      .then((entries) => {
        if (!ignore) setRuns(entries)
      })
      .catch(() => {
        if (!ignore) setLoaded(true)
      })
    return () => {
      ignore = true
    }
  }, [metadataLoc])

  async function persist(next: IntakeConfig) {
    setConfig(next)
    setSaving(true)
    setError(null)
    try {
      await saveIntakeConfig(metadataLoc, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  async function checkLeftovers() {
    if (!config) return
    setChecking(true)
    setError(null)
    setConfirmingFolders(false)
    try {
      setLeftovers(await findLeftovers(metadataLoc, config))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not go through the photo folder.')
    } finally {
      setChecking(false)
    }
  }

  // Both of these end by looking again rather than adjusting the numbers on
  // screen: what's left is a question about the folder, and the folder has
  // just changed.
  async function removeFolders() {
    if (!config || !leftovers) return
    setConfirmingFolders(false)
    setError(null)
    setWorking('Removing empty folders…')
    try {
      const result = await removeEmptyFolders(config, leftovers.emptyFolders, {
        onProgress: (done, total) => setWorking(`Removing empty folders — ${done} of ${total}`),
      })
      const entry: IntakeLogEntry = {
        at: new Date().toISOString(),
        kind: 'folders',
        foldersRemoved: result.removed,
        failed: result.failed.length,
      }
      setRuns(await appendIntakeLog(metadataLoc, entry).catch(() => [entry, ...runs]))
      if (result.failed.length > 0) {
        setError(`${result.failed.length} could not be removed: ${result.failed[0].error}`)
      }
      setWorking('Checking what is left…')
      setLeftovers(await findLeftovers(metadataLoc, config))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the folders.')
    } finally {
      setWorking(null)
    }
  }

  async function prune() {
    if (!config) return
    setError(null)
    setWorking('Going through the decisions…')
    try {
      const result = await pruneSetAside(metadataLoc, config)
      setSetAside(result.kept)
      const entry: IntakeLogEntry = {
        at: new Date().toISOString(),
        kind: 'forget',
        forgotten: result.forgotten,
      }
      setRuns(await appendIntakeLog(metadataLoc, entry).catch(() => [entry, ...runs]))
      setLeftovers(await findLeftovers(metadataLoc, config))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not go through the decisions.')
    } finally {
      setWorking(null)
    }
  }

  function pick(which: 'source' | 'dest', loc: MountpointRef & { path?: string }) {
    const folder: FolderRef = { device: loc.device, mountpoint: loc.mountpoint, path: loc.path ?? '' }
    // Both are needed before it can run, so an incomplete pair is stored with
    // the switch off rather than refused.
    const next: IntakeConfig = {
      source: which === 'source' ? folder : config?.source ?? folder,
      dest: which === 'dest' ? folder : config?.dest ?? folder,
      enabled: config?.enabled ?? false,
      mode: config?.mode ?? 'copy',
    }
    setPicking(null)
    void persist(next)
  }

  if (!loaded) return null

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Filing new artwork</h2>
      <p className="mt-1 text-xs text-zinc-500">
        When you open the app it can look through the pictures your iPad has backed up, pick out the ones
        PicsArt or an AI tool made, and offer to file them with your artwork. It reads what the files
        themselves record, so it doesn&rsquo;t depend on how they&rsquo;re named — and it always asks before
        touching anything.
      </p>

      <dl className="mt-3 flex flex-col gap-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span>
            <dt className="inline text-zinc-500">New artwork and photos arrive in </dt>
            <dd className="inline font-medium">{label(config?.source ?? null)}</dd>
          </span>
          <button
            onClick={() => setPicking(picking === 'source' ? null : 'source')}
            className="shrink-0 text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {picking === 'source' ? 'Cancel' : 'Change'}
          </button>
        </div>
        {picking === 'source' && <LocationPicker onSelect={(loc) => pick('source', loc)} />}

        <div className="flex items-center justify-between gap-2">
          <span>
            {/* "them" read as everything in the folder above. Only the
                pictures that say they were made in PicsArt or by an AI tool
                are ever touched; the photographs stay where they are. */}
            <dt className="inline text-zinc-500">
              {config?.mode === 'move' ? 'Move the artwork to ' : 'Copy the artwork to '}
            </dt>
            <dd className="inline font-medium">{label(config?.dest ?? null)}</dd>
          </span>
          <button
            onClick={() => setPicking(picking === 'dest' ? null : 'dest')}
            className="shrink-0 text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {picking === 'dest' ? 'Cancel' : 'Change'}
          </button>
        </div>
        {picking === 'dest' && <LocationPicker onSelect={(loc) => pick('dest', loc)} />}
      </dl>

      {/* Which one is right depends on what the source folder is for, and
          only you know that — a phone backup is supposed to hold everything
          the phone has, while a photo library you actually look through is
          better off without the artwork mixed into it. */}
      <fieldset className="mt-3 text-xs">
        <legend className="text-zinc-500">When a picture is filed</legend>
        <div className="mt-1 flex flex-col gap-1">
          {(
            [
              ['copy', 'Leave a copy where it was', 'Nothing is removed. The picture ends up in both places.'],
              [
                'move',
                'Take it out of the photos',
                'Removed once the copy has succeeded, never before. Removed pictures go to Jottacloud’s trash, so a mistake can be undone there.',
              ],
            ] as const
          ).map(([value, title, detail]) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="intake-mode"
                checked={(config?.mode ?? 'copy') === value}
                disabled={!config}
                onChange={() => config && void persist({ ...config, mode: value })}
                className="mt-0.5 shrink-0"
              />
              <span>
                {title}
                <span className="block text-zinc-500">{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-3 flex w-fit items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={config?.enabled === true}
          disabled={!config?.source || !config?.dest}
          onChange={(e) => config && void persist({ ...config, enabled: e.target.checked })}
        />
        <span className={!config?.source || !config?.dest ? 'text-zinc-400' : undefined}>
          Look for new artwork when the app opens
          {(!config?.source || !config?.dest) && <span className="block">Set both folders first.</span>}
        </span>
      </label>

      {/* The counterpart of "Never" in the banner. Without this, one tap on a
          picture would be final and invisible — and the same list also holds
          everything the scan itself rejected, so emptying it is how you make
          it look again after the detection improves. */}
      {setAside > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          {/* {' '} rather than a plain space: a text chunk that wraps onto the
              next source line has its leading space trimmed away, which is how
              this came to read "5,665 picturesset aside". */}
          {setAside.toLocaleString()} photo{setAside === 1 ? '' : 's'} found. Left {setAside === 1 ? 'it' : 'them'}{' '}
          in {config?.source ? label(config.source) : 'the photo folder'}.{' '}
          <button
            onClick={async () => {
              setForgetting(true)
              try {
                await forgetNotArtwork(metadataLoc)
                setSetAside(0)
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not clear the list.')
              } finally {
                setForgetting(false)
              }
            }}
            disabled={forgetting}
            className="text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
          >
            {forgetting ? 'Clearing…' : 'Look at them again'}
          </button>
        </p>
      )}

      {/* What moving leaves behind. Neither of these is found without walking
          the photo folder, which is minutes of requests, so it's asked for
          rather than worked out every time this page opens. */}
      {config?.source && (
        <div className="mt-3 rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
          <p className="text-zinc-500">
            Moving pictures out leaves their folders behind, and leaves decisions recorded about
            pictures that are no longer there.
          </p>
          {leftovers === null ? (
            <button
              onClick={checkLeftovers}
              disabled={checking}
              className="mt-1 text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
            >
              {checking ? 'Going through the photo folder…' : 'Check what has been left behind'}
            </button>
          ) : (
            <div className="mt-1 flex flex-col gap-2">
              <p className="text-zinc-500">
                {leftovers.pictures.toLocaleString()} picture
                {leftovers.pictures === 1 ? '' : 's'} in {leftovers.folders.toLocaleString()} folder
                {leftovers.folders === 1 ? '' : 's'}.{' '}
                {leftovers.emptyFoldersTotal > 0
                  ? `${leftovers.emptyFoldersTotal.toLocaleString()} of those folders hold no pictures at all.`
                  : 'No empty folders.'}{' '}
                {leftovers.setAsideStale > 0
                  ? `${leftovers.setAsideStale.toLocaleString()} of the ${leftovers.setAsideTotal.toLocaleString()} decisions are about pictures no longer in there.`
                  : 'Every decision is about a picture still in there.'}
              </p>

              {leftovers.emptyFolders.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {confirmingFolders ? (
                    <>
                      <button
                        onClick={removeFolders}
                        disabled={working !== null}
                        className="rounded bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                      >
                        Yes, remove {leftovers.emptyFoldersTotal.toLocaleString()} empty folder
                        {leftovers.emptyFoldersTotal === 1 ? '' : 's'}
                      </button>
                      <button onClick={() => setConfirmingFolders(false)} className="text-zinc-600 dark:text-zinc-400">
                        Cancel
                      </button>
                      <span className="text-zinc-500">
                        They go to Jottacloud&rsquo;s trash. Only folders with no picture anywhere beneath
                        them are touched.
                      </span>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmingFolders(true)}
                      disabled={working !== null}
                      className="rounded bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      Remove the empty folders
                    </button>
                  )}
                </div>
              )}

              {leftovers.setAsideStale > 0 && (
                <button
                  onClick={prune}
                  disabled={working !== null}
                  className="self-start text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
                >
                  Forget the {leftovers.setAsideStale.toLocaleString()} decision
                  {leftovers.setAsideStale === 1 ? '' : 's'} about pictures that have gone
                </button>
              )}

              {working && <p className="text-zinc-400">{working}</p>}
              <button onClick={checkLeftovers} disabled={working !== null} className="self-start text-zinc-500 hover:underline disabled:opacity-50">
                Check again
              </button>
            </div>
          )}
        </div>
      )}

      {/* Every run leaves a line here. The banner that reports a run lives on
          a screen you leave immediately afterwards, so without this there was
          no way to see what a run had done once it was over. */}
      {runs.length > 0 && (
        <div className="mt-3 text-xs">
          <button
            onClick={() => setShowRuns((v) => !v)}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {showRuns ? 'Hide what it has done' : `What it has done (${runs.length})`}
          </button>
          {showRuns && (
            <ul className="mt-2 flex flex-col gap-1">
              {runs.map((entry) => {
                // Only what's genuinely outstanding. "Nothing to do" against
                // every run in a list is noise, not reassurance.
                const needs = runNeeds(entry)
                return (
                  <li key={entry.at} className="flex flex-wrap gap-x-2 text-zinc-500">
                    <span className="text-zinc-400">{new Date(entry.at).toLocaleString()}</span>
                    <span>
                      {runLabel(entry.kind)} — {summariseRun(entry)}
                      {needs?.where === 'look' && (
                        <span className="block text-amber-700 dark:text-amber-500">{needs.what}</span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {saving && <p className="mt-2 text-xs text-zinc-400">Saving…</p>}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
