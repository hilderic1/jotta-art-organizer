'use client'

import { useCallback, useEffect, useState } from 'react'
import { setMetadataLocation, type MountpointRef } from '@/lib/api'
import {
  findCatalogues,
  holdsCatalogue,
  rememberLocation,
  type CatalogueCandidate,
} from '@/lib/catalogueLocation'

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} B`
}

/**
 * Where the catalogue is kept: named when known, searched for when not.
 *
 * Answering this wrongly starts a second, empty catalogue somewhere else,
 * which looks exactly like the first one having been emptied — so the choice
 * is never offered as a list of bare mountpoint names. Each one is weighed by
 * what is actually in it, and the one holding the tags says so.
 */
export function CatalogueLocation({
  current,
  onChange,
}: {
  current: MountpointRef | null
  onChange: (loc: MountpointRef) => void
}) {
  const [candidates, setCandidates] = useState<CatalogueCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(async () => {
    setSearching(true)
    setError(null)
    try {
      setCandidates(await findCatalogues())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not search your account.')
    } finally {
      setSearching(false)
    }
  }, [])

  // Searched straight away when there is no answer, because until there is
  // one the app is missing features and not saying so. State is set from the
  // promise rather than in the effect body, which would make React render
  // twice for one decision.
  useEffect(() => {
    if (current) return
    let ignore = false
    findCatalogues()
      .then((found) => {
        if (!ignore) setCandidates(found)
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not search your account.')
      })
    return () => {
      ignore = true
    }
  }, [current])

  async function choose(loc: MountpointRef) {
    const key = `${loc.device}/${loc.mountpoint}`
    setSaving(key)
    setError(null)
    try {
      await setMetadataLocation(loc)
      // Both: the session for this visit, the device so a reconnect doesn't
      // ask again. Being asked again is how the wrong one got picked.
      rememberLocation(loc)
      onChange(loc)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it.')
    } finally {
      setSaving(null)
    }
  }

  const real = candidates?.filter(holdsCatalogue) ?? []
  const rest = candidates?.filter((c) => !holdsCatalogue(c)) ?? []
  const currentKey = current ? `${current.device}/${current.mountpoint}` : null
  // Shown while the first search is still out, which is not the same as the
  // button having been pressed — hence not folded into `searching`.
  const firstLook = !current && candidates === null && !error

  return (
    <section
      className={
        current
          ? 'rounded-lg border border-zinc-200 p-3 dark:border-zinc-800'
          : 'rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950'
      }
    >
      <h2 className="text-sm font-medium">
        {current ? 'Where the catalogue is kept' : 'Where is your catalogue kept?'}
      </h2>

      {current ? (
        <p className="mt-1 text-xs text-zinc-500">
          Tags, filing settings and run logs are read from{' '}
          <strong>
            {current.device}/{current.mountpoint}
          </strong>
          . Remembered on this device, and found again by looking in your account when it isn&rsquo;t —
          so the iPad, the phone and the laptop all reach the same catalogue without being asked.{' '}
          <button
            onClick={() => void search()}
            disabled={searching}
            className="text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
          >
            {searching ? 'Looking…' : 'Check for catalogues elsewhere'}
          </button>
        </p>
      ) : (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Nothing is lost — your tags and settings are files in Jottacloud — but the app doesn&rsquo;t know
          which mountpoint to read them from, so filing and everything built on it aren&rsquo;t shown.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {(firstLook || (searching && candidates === null)) && (
        <p className="mt-2 text-xs text-zinc-500">Looking through your mountpoints…</p>
      )}

      {candidates && (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          {/* Two catalogues is the situation to be honest about: it happens by
              answering this question wrongly once, and the counts are what
              tell them apart. */}
          {real.length > 1 && (
            <p className="text-amber-700 dark:text-amber-500">
              There are {real.length} catalogues in this account. The one with the most in it is almost
              certainly the real one; a small one is what gets started by picking the wrong mountpoint
              once. Nothing here removes either — picking one only changes which is read.
            </p>
          )}
          {real.length === 0 && (
            <p className="text-zinc-500">
              No catalogue found anywhere in this account yet. Picking a mountpoint below starts one.
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {(showAll ? [...real, ...rest] : real).map((c) => {
              const key = `${c.loc.device}/${c.loc.mountpoint}`
              const chosen = key === currentKey
              return (
                <li key={key} className="flex flex-wrap items-baseline gap-2">
                  <button
                    onClick={() => void choose(c.loc)}
                    disabled={saving !== null || chosen}
                    className={
                      chosen
                        ? 'rounded border border-emerald-400 px-2 py-1 font-medium text-emerald-800 dark:border-emerald-700 dark:text-emerald-300'
                        : holdsCatalogue(c)
                          ? 'rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50'
                          : 'rounded border border-zinc-300 px-2 py-1 hover:bg-white disabled:opacity-50 dark:border-zinc-700'
                    }
                  >
                    {saving === key ? 'Saving…' : chosen ? `${key} — in use` : key}
                  </button>
                  <span className="text-zinc-600 dark:text-zinc-400">
                    {c.error
                      ? c.error
                      : holdsCatalogue(c)
                        ? [
                            `${c.shards.toLocaleString()} tag file${c.shards === 1 ? '' : 's'}`,
                            size(c.bytes),
                            c.hasCategories ? null : 'no category list',
                            c.hasLegacy ? 'older format' : null,
                            c.changedAt ? `last changed ${new Date(c.changedAt).toLocaleDateString()}` : null,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        : c.hasFolder
                          ? 'has the folder but no tags in it'
                          : 'nothing here'}
                  </span>
                </li>
              )
            })}
          </ul>

          {rest.length > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="self-start text-zinc-500 hover:underline"
            >
              {showAll
                ? 'Hide the empty ones'
                : `Show the other ${rest.length} mountpoint${rest.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
