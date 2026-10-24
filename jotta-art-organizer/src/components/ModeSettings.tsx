'use client'

import { useEffect, useState } from 'react'
import { KNOWN_CATEGORY_NAMES, loadMetadata, type Category } from '@/lib/metadata'
import type { MountpointRef } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import {
  loadModeConfig,
  saveModeConfig,
  scopeOf,
  MODE_NAMES,
  MODE_DESCRIPTIONS,
  type AppMode,
  type CategoryScope,
  type ModeConfig,
} from '@/lib/mode'

const MODES: AppMode[] = ['general', 'photos', 'artwork']
const SCOPES: { value: CategoryScope; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'photos', label: 'Photos' },
  { value: 'artwork', label: 'PicsArt' },
]

/**
 * Which job the app is set up for, and what belongs to each.
 *
 * The mode itself is three buttons. The per-category split underneath is
 * folded away, because it is a thing to correct once and then forget — but it
 * is here rather than in the code, since which characteristics belong to
 * photographs and which to her own work is hers to say.
 */
export function ModeSettings({
  metadataLoc,
  onChange,
}: {
  metadataLoc: MountpointRef
  /** So the page around this can rearrange itself as soon as the mode
   *  changes, rather than after a reload. */
  onChange?: (config: ModeConfig) => void
}) {
  const [config, setConfig] = useState<ModeConfig | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [showSplit, setShowSplit] = useState(false)
  const [picking, setPicking] = useState<Exclude<AppMode, 'general'> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    loadModeConfig(metadataLoc)
      .then((loaded) => {
        if (!ignore) setConfig(loaded)
      })
      .catch(() => {
        if (!ignore) setConfig({ mode: 'general' })
      })
    return () => {
      ignore = true
    }
  }, [metadataLoc])

  // Only when the split is opened: the whole catalogue has to be read to know
  // which categories exist, and nobody opening Setup needs that.
  useEffect(() => {
    if (!showSplit || categories) return
    let ignore = false
    loadMetadata(metadataLoc)
      .then((store) => {
        if (!ignore) setCategories(store.categories)
      })
      .catch(() => {
        if (!ignore) setCategories([])
      })
    return () => {
      ignore = true
    }
  }, [showSplit, categories, metadataLoc])

  async function persist(next: ModeConfig) {
    setConfig(next)
    onChange?.(next)
    setSaving(true)
    setError(null)
    try {
      await saveModeConfig(metadataLoc, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it.')
    } finally {
      setSaving(false)
    }
  }

  if (!config) return null

  const folder = (mode: Exclude<AppMode, 'general'>) => config.folders?.[mode] ?? null
  const label = (mode: Exclude<AppMode, 'general'>) => {
    const f = folder(mode)
    return f ? (f.path ? `${f.mountpoint}/${f.path}` : f.mountpoint) : 'not set'
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">What this app is for</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Pick the job and the rest of the app follows: it starts in that folder, leaves out the
        characteristics belonging to the other job, and puts away the instruments that belong to neither.
      </p>

      <div className="mt-2 flex flex-col gap-1">
        {MODES.map((mode) => (
          <label key={mode} className="flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="app-mode"
              checked={config.mode === mode}
              onChange={() => void persist({ ...config, mode })}
              className="mt-0.5 shrink-0"
            />
            <span>
              {MODE_NAMES[mode]}
              <span className="block text-zinc-500">{MODE_DESCRIPTIONS[mode]}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Both folders are settable whichever mode is in force, so switching
          to a mode never lands on a question. */}
      <dl className="mt-3 flex flex-col gap-2 text-xs">
        {(['photos', 'artwork'] as const).map((mode) => (
          <div key={mode}>
            <div className="flex items-center justify-between gap-2">
              <span>
                <dt className="inline text-zinc-500">{MODE_NAMES[mode]} works in </dt>
                <dd className="inline font-medium">{label(mode)}</dd>
              </span>
              <button
                onClick={() => setPicking(picking === mode ? null : mode)}
                className="shrink-0 text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {picking === mode ? 'Cancel' : 'Change'}
              </button>
            </div>
            {picking === mode && (
              <LocationPicker
                onSelect={(loc) => {
                  setPicking(null)
                  void persist({
                    ...config,
                    folders: {
                      ...config.folders,
                      [mode]: { device: loc.device, mountpoint: loc.mountpoint, path: loc.path ?? '' },
                    },
                  })
                }}
              />
            )}
          </div>
        ))}
      </dl>

      <button
        onClick={() => setShowSplit((v) => !v)}
        className="mt-3 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
      >
        {showSplit ? 'Hide which characteristic belongs to which' : 'Which characteristic belongs to which?'}
      </button>

      {showSplit && (
        <div className="mt-2 text-xs">
          <p className="text-zinc-500">
            A characteristic set to one job is hidden in the other. Anything left on Both shows in all
            three modes, which is where a new one starts.
          </p>
          {categories === null ? (
            <p className="mt-1 text-zinc-400">Reading the catalogue…</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {[...categories]
                .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
                .map((category) => {
                  const current = scopeOf(category.id, config)
                  return (
                    <li key={category.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{category.name || KNOWN_CATEGORY_NAMES[category.id] || category.id}</span>
                      <span className="flex gap-1">
                        {SCOPES.map((scope) => (
                          <button
                            key={scope.value}
                            onClick={() =>
                              void persist({
                                ...config,
                                categoryScopes: { ...config.categoryScopes, [category.id]: scope.value },
                              })
                            }
                            className={
                              current === scope.value
                                ? 'rounded bg-indigo-600 px-2 py-0.5 font-medium text-white'
                                : 'rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900'
                            }
                          >
                            {scope.label}
                          </button>
                        ))}
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
