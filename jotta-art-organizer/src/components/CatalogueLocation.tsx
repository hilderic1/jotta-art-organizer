'use client'

import { useEffect, useState } from 'react'
import {
  listMountpoints,
  listFolder,
  setMetadataLocation,
  type MountpointRef,
} from '@/lib/api'

/** The folder every setting, tag and log this app keeps lives in. */
const STORE_FOLDER = '.jotta-art-organizer'

/**
 * Where the catalogue is kept, shown and settable.
 *
 * This lives in the session, not in Jottacloud — it can't, since it is the
 * answer to "where in Jottacloud do I look?" — so reconnecting the account
 * loses it. Until now it was only ever set as a side effect of first using
 * the Catalogue, which meant that after a reconnect everything built on it
 * silently vanished: filing, its settings, its log, the leftovers check. Not
 * broken, and not deleted — just unreachable, with nothing on screen saying
 * why.
 *
 * So it is named here, and the places that already hold a catalogue are
 * marked, because picking the wrong one looks exactly like having lost
 * everything.
 */
export function CatalogueLocation({
  current,
  onChange,
}: {
  current: MountpointRef | null
  onChange: (loc: MountpointRef) => void
}) {
  const [options, setOptions] = useState<{ loc: MountpointRef; hasStore: boolean }[] | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    // Only looked up when it needs choosing: one listing per mountpoint is
    // cheap, but pointless when the answer is already known.
    if (current) return
    listMountpoints()
      .then(async (mountpoints) => {
        const found: { loc: MountpointRef; hasStore: boolean }[] = []
        for (const loc of mountpoints) {
          const listing = await listFolder(loc, '').catch(() => null)
          found.push({
            loc,
            hasStore: listing?.folders.some((f) => f.name === STORE_FOLDER) ?? false,
          })
        }
        if (!ignore) setOptions(found)
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not list your mountpoints.')
      })
    return () => {
      ignore = true
    }
  }, [current])

  async function choose(loc: MountpointRef) {
    setSaving(`${loc.device}/${loc.mountpoint}`)
    setError(null)
    try {
      await setMetadataLocation(loc)
      onChange(loc)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it.')
    } finally {
      setSaving(null)
    }
  }

  if (current) {
    return (
      <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Where the catalogue is kept</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Tags, filing settings and run logs are held in {STORE_FOLDER} in{' '}
          <strong>
            {current.device}/{current.mountpoint}
          </strong>
          . This is remembered on this device only, so reconnecting your account asks for it again — and
          until it is answered, everything built on it is out of reach.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
      <h2 className="text-sm font-medium">Where is your catalogue kept?</h2>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Nothing is lost — your tags, filing settings and logs are files in Jottacloud — but the app
        doesn&rsquo;t know which mountpoint to read them from, so filing and everything built on it
        aren&rsquo;t shown. Pick the one you used before; they are marked below.
      </p>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {options === null && !error && <p className="mt-2 text-xs text-zinc-500">Looking…</p>}

      {options && (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {/* The ones already holding a catalogue first, since one of those is
              almost certainly the answer. */}
          {[...options]
            .sort((a, b) => Number(b.hasStore) - Number(a.hasStore))
            .map(({ loc, hasStore }) => {
              const key = `${loc.device}/${loc.mountpoint}`
              return (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => choose(loc)}
                    disabled={saving !== null}
                    className={
                      hasStore
                        ? 'rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50'
                        : 'rounded border border-zinc-300 px-2 py-1 hover:bg-white disabled:opacity-50 dark:border-zinc-700'
                    }
                  >
                    {saving === key ? 'Saving…' : key}
                  </button>
                  {hasStore && (
                    <span className="text-zinc-600 dark:text-zinc-400">
                      already holds a catalogue — almost certainly this one
                    </span>
                  )}
                </li>
              )
            })}
        </ul>
      )}
    </section>
  )
}
