'use client'

import { useEffect, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import { loadIntakeConfig, saveIntakeConfig, type FolderRef, type IntakeConfig } from '@/lib/photoIntake'

function label(folder: FolderRef | null): string {
  if (!folder) return 'not set'
  return folder.path ? `${folder.mountpoint}/${folder.path}` : folder.mountpoint
}

/**
 * Where new pictures arrive, and where her work is kept.
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

  useEffect(() => {
    let ignore = false
    loadIntakeConfig(metadataLoc)
      .then((stored) => {
        if (ignore) return
        setConfig(stored)
        setLoaded(true)
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

  function pick(which: 'source' | 'dest', loc: MountpointRef & { path?: string }) {
    const folder: FolderRef = { device: loc.device, mountpoint: loc.mountpoint, path: loc.path ?? '' }
    // Both are needed before it can run, so an incomplete pair is stored with
    // the switch off rather than refused.
    const next: IntakeConfig = {
      source: which === 'source' ? folder : config?.source ?? folder,
      dest: which === 'dest' ? folder : config?.dest ?? folder,
      enabled: config?.enabled ?? false,
    }
    setPicking(null)
    void persist(next)
  }

  if (!loaded) return null

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Filing new work</h2>
      <p className="mt-1 text-xs text-zinc-500">
        When you open the app it can look through the pictures your iPad has backed up, pick out the ones
        PicsArt or an AI tool made, and offer to copy them in with your artwork. It reads what the files
        themselves record, so it doesn&rsquo;t depend on how they&rsquo;re named — and it always asks before
        copying anything. Originals stay in the backup untouched.
      </p>

      <dl className="mt-3 flex flex-col gap-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span>
            <dt className="inline text-zinc-500">New pictures arrive in </dt>
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
            <dt className="inline text-zinc-500">Copy them to </dt>
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

      <label className="mt-3 flex w-fit items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={config?.enabled === true}
          disabled={!config?.source || !config?.dest}
          onChange={(e) => config && void persist({ ...config, enabled: e.target.checked })}
        />
        <span className={!config?.source || !config?.dest ? 'text-zinc-400' : undefined}>
          Look for new work when the app opens
          {(!config?.source || !config?.dest) && <span className="block">Set both folders first.</span>}
        </span>
      </label>

      {saving && <p className="mt-2 text-xs text-zinc-400">Saving…</p>}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
