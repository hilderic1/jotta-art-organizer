'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, setMetadataLocation, type SessionStatus, type MountpointRef, type JottaEntry } from '@/lib/api'
import { loadMetadataForFolder, saveArtworkChanges, ensureCategoriesForTags, type MetadataStore, type Category, type ArtworkTags } from '@/lib/metadata'
import { LocationPicker } from '@/components/LocationPicker'
import { CategoryManager } from '@/components/CategoryManager'
import { TagAssignBrowser } from '@/components/TagAssignBrowser'
import { TagFilterBrowser } from '@/components/TagFilterBrowser'
import { BatchTagBrowser } from '@/components/BatchTagBrowser'
import { BatchVisionClassifyBrowser } from '@/components/BatchVisionClassifyBrowser'

type Mode = 'assign' | 'browse' | 'batch' | 'classify' | 'categories'

export default function TagsPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [settingUpLocation, setSettingUpLocation] = useState(false)
  const [store, setStore] = useState<MetadataStore | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('assign')
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false)
  const [selectedBrowseLocation, setSelectedBrowseLocation] = useState<(MountpointRef & { path?: string }) | null>(null)
  const [loadStats, setLoadStats] = useState<{ loaded: number; total: number } | null>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  useEffect(() => {
    if (!session?.authenticated || !session.metadataLocation || !selectedBrowseLocation) return
    let ignore = false
    setIsLoadingMetadata(true)
    setLoadError(null)
    loadMetadataForFolder(session.metadataLocation, selectedBrowseLocation)
      .then((result) => {
        if (!ignore) {
          setStore(result.store)
          setLoadStats({ loaded: result.shardsLoaded, total: result.shardsTotal })
          setIsLoadingMetadata(false)
        }
      })
      .catch((err) => {
        if (!ignore) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load tag data.')
          setIsLoadingMetadata(false)
        }
      })
    return () => {
      ignore = true
    }
  }, [session, selectedBrowseLocation])

  // Picking a folder always discards the previous folder's data, so step 2
  // (the loading state) is what renders next rather than stale tags.
  function pickFolder(loc: MountpointRef & { path?: string }) {
    setStore(null)
    setLoadStats(null)
    setLoadError(null)
    setSelectedBrowseLocation(loc)
  }

  function clearFolder() {
    setStore(null)
    setLoadStats(null)
    setLoadError(null)
    setSelectedBrowseLocation(null)
  }

  async function handleCategoriesChange(nextCategories: Category[]) {
    if (!store || !session?.authenticated || !session.metadataLocation) return
    setStore({ ...store, categories: nextCategories })
    setSaveError(null)
    try {
      await saveArtworkChanges(session.metadataLocation, nextCategories)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save categories.')
    }
  }

  async function handleChooseLocation(loc: MountpointRef) {
    setSettingUpLocation(true)
    try {
      await setMetadataLocation(loc)
      setSession((prev) => (prev?.authenticated ? { ...prev, metadataLocation: loc } : prev))
    } finally {
      setSettingUpLocation(false)
    }
  }

  async function handleSaveTags(entry: JottaEntry, loc: MountpointRef, tags: Record<string, string[]>) {
    if (!store || !entry.md5 || !session?.authenticated || !session.metadataLocation) return
    const filteredTags = Object.fromEntries(Object.entries(tags).filter(([, values]) => values.length > 0))
    const withoutThis = store.artworks.filter((a) => a.md5 !== entry.md5)

    // Auto-register categories/values referenced for the first time (e.g.
    // "People" names pulled in from Google Photos metadata) rather than
    // silently dropping tags that don't have a matching category yet.
    const categories = ensureCategoriesForTags(store.categories, filteredTags)

    let nextArtworks: ArtworkTags[]
    let upsert: ArtworkTags[] = []
    let remove: string[] = []
    if (Object.keys(filteredTags).length === 0) {
      nextArtworks = withoutThis
      remove = [entry.md5]
    } else {
      const newEntry: ArtworkTags = {
        md5: entry.md5,
        device: loc.device,
        mountpoint: loc.mountpoint,
        path: entry.path,
        lastSeenAt: new Date().toISOString(),
        tags: filteredTags,
      }
      nextArtworks = [...withoutThis, newEntry]
      upsert = [newEntry]
    }

    // Only the categories file (small, always cheap) plus whichever
    // artwork shard this one md5 belongs to get rewritten — not every
    // tagged file in the library.
    setStore({ categories, artworks: nextArtworks })
    setSaveError(null)
    try {
      await saveArtworkChanges(session.metadataLocation, categories, { upsert, remove })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save tag data.'
      setSaveError(message)
      // Re-throw so callers awaiting a save (e.g. the tag editor modal) know
      // it failed rather than assuming success.
      throw err
    }
  }

  if (session === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  if (!session.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your Jottacloud account first.</p>
        <Link href="/setup" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  if (!session.metadataLocation) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-6 py-10">
        <div>
          <h1 className="text-2xl font-semibold">Set up tags</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Pick where to keep what you write about your work. It lives in your own Jottacloud
            account, in a folder this app looks after — your artwork itself is never changed. You
            only choose this once.
          </p>
        </div>
        <LocationPicker onSelect={handleChooseLocation} />
        {settingUpLocation && <p className="text-sm text-zinc-500">Saving…</p>}
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      </div>
    )
  }

  const header = (
    <div>
      <h1 className="text-2xl font-semibold">Tags</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Give a piece a title, a style and a subject, note the figures you can see in it, and link an
        enhanced version back to the original it came from. Dates, places and camera details are read
        out of the files themselves — so what you add here is what a file can&rsquo;t say for itself.
        Then find any piece by any of it.
      </p>
    </div>
  )

  // Step 1 — nothing is loaded until a folder has been chosen.
  if (!selectedBrowseLocation) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        {header}
        <p className="text-sm text-zinc-500">
          Choose the folder holding the work you want to tag. Only what that folder needs is loaded,
          and you can switch to another one at any time.
        </p>
        <LocationPicker onSelect={pickFolder} />
      </div>
    )
  }

  const folderLabel = selectedBrowseLocation.path
    ? `${selectedBrowseLocation.mountpoint}/${selectedBrowseLocation.path}`
    : selectedBrowseLocation.mountpoint

  // Step 2 — that folder's tag data is on its way.
  if (!store) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        {header}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600 dark:border-zinc-700 dark:border-t-indigo-500" />
          Loading tag data for {folderLabel}…
        </div>
        <button onClick={clearFolder} className="self-start text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Choose a different folder
        </button>
      </div>
    )
  }

  // Step 3 — folder chosen and loaded: every sub-task works off it, no more picking.
  // Only categories that actually have values in this folder are worth showing.
  // Per-category, so a value used under "Year" can't keep an unrelated
  // category like "Creation Time" alive just because the string matches.
  const usedByCategory = new Map<string, Set<string>>()
  for (const artwork of store.artworks) {
    for (const [categoryId, values] of Object.entries(artwork.tags)) {
      let used = usedByCategory.get(categoryId)
      if (!used) {
        used = new Set<string>()
        usedByCategory.set(categoryId, used)
      }
      for (const value of values) used.add(value)
    }
  }
  const filteredCategories = store.categories
    .map((cat) => ({ ...cat, values: cat.values.filter((v) => usedByCategory.get(cat.id)?.has(v)) }))
    .filter((cat) => cat.values.length > 0)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      {header}

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate text-zinc-600 dark:text-zinc-400">
          🗂 {folderLabel}{' '}
          <span className="text-xs text-zinc-400">
            ({store.artworks.length} tagged
            {loadStats && loadStats.total > 0 && `; read ${loadStats.loaded} of ${loadStats.total} shards`})
          </span>
        </span>
        <button onClick={clearFolder} className="shrink-0 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          Change folder
        </button>
      </div>

      <div className="flex gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        {(
          [
            ['assign', 'Assign tags'],
            ['browse', 'Browse by tag'],
            ['batch', 'Batch tagging'],
            ['classify', 'AI Classify'],
            ['categories', 'Categories'],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              mode === m ? 'bg-indigo-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

      {isLoadingMetadata && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Refreshing tag data…
        </div>
      )}

      {mode === 'categories' && <CategoryManager categories={store.categories} onChange={handleCategoriesChange} />}

      {/* Assign gets every category, not just the ones already in use here —
          otherwise a folder with nothing tagged yet shows no categories at
          all and there's no way to apply a first tag. */}
      {mode === 'assign' && (
        <TagAssignBrowser
          categories={store.categories}
          artworks={store.artworks}
          onSave={handleSaveTags}
          initialLocation={selectedBrowseLocation}
        />
      )}

      {mode === 'browse' && <TagFilterBrowser categories={filteredCategories} artworks={store.artworks} />}

      {mode === 'batch' && (
        <BatchTagBrowser store={store} onStoreUpdated={setStore} initialLocation={selectedBrowseLocation} />
      )}

      {mode === 'classify' && (
        <BatchVisionClassifyBrowser store={store} onStoreUpdated={setStore} initialLocation={selectedBrowseLocation} />
      )}
    </div>
  )
}
