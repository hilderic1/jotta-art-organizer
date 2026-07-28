'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, setMetadataLocation, type SessionStatus, type MountpointRef, type JottaEntry } from '@/lib/api'
import { loadMetadata, saveArtworkChanges, ensureCategoriesForTags, type MetadataStore, type Category, type ArtworkTags } from '@/lib/metadata'
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
  const [selectedBrowseLocation, setSelectedBrowseLocation] = useState<MountpointRef & { path?: string } | null>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  useEffect(() => {
    if (!session?.authenticated || !session.metadataLocation) return
    let ignore = false
    setIsLoadingMetadata(true)
    setLoadError(null)
    loadMetadata(session.metadataLocation)
      .then((data) => {
        if (!ignore) {
          setStore(data)
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
  }, [session])

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
            Pick where to store the tag database — a small JSON file this app manages inside your Jottacloud account.
            This only needs to be done once.
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

  if (!store) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        <div>
          <h1 className="text-2xl font-semibold">Tags</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Classify artwork by characteristics (style, subject, mood, …) instead of folder location, then browse by any
            combination of them.
          </p>
        </div>
        <div className="flex flex-1 items-center justify-center rounded border border-zinc-200 bg-zinc-50 py-20 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-indigo-600 dark:border-zinc-700 dark:border-t-indigo-500"></div>
            Loading tag data… (this may take a moment with large libraries)
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10 ${isLoadingMetadata ? 'opacity-60 pointer-events-none' : ''}`}>
      <div>
        <h1 className="text-2xl font-semibold">Tags</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Classify artwork by characteristics (style, subject, mood, …) instead of folder location, then browse by any
          combination of them.
        </p>
      </div>

      {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

      {isLoadingMetadata && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Refreshing tag data…
        </div>
      )}

      <div className="flex gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        {(
          [
            ['assign', 'Assign tags'],
            ['browse', 'Browse by tag'],
            ['batch', 'Batch import'],
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

      {mode !== 'categories' && <LocationPicker onSelect={setSelectedBrowseLocation} />}

      {mode === 'categories' && <CategoryManager categories={store.categories} onChange={handleCategoriesChange} />}

      {mode !== 'categories' && selectedBrowseLocation && (() => {
        // Filter artworks by selected location
        const filteredArtworks = store.artworks.filter((a) => {
          if (a.device !== selectedBrowseLocation.device || a.mountpoint !== selectedBrowseLocation.mountpoint) return false
          if (selectedBrowseLocation.path) {
            const path = selectedBrowseLocation.path.trim()
            return a.path === path || a.path.startsWith(path + '/')
          }
          return true
        })

        // Find which tags are used in filtered artworks
        const usedTagValues = new Set<string>()
        for (const artwork of filteredArtworks) {
          for (const values of Object.values(artwork.tags)) {
            for (const value of values) {
              usedTagValues.add(value)
            }
          }
        }

        // Filter categories to only include those with used values
        const filteredCategories = store.categories.map((cat) => ({
          ...cat,
          values: cat.values.filter((v) => usedTagValues.has(v)),
        }))

        return (
          <>
            {mode === 'assign' && (
              <TagAssignBrowser categories={filteredCategories} artworks={filteredArtworks} onSave={handleSaveTags} />
            )}

            {mode === 'browse' && <TagFilterBrowser categories={filteredCategories} artworks={filteredArtworks} />}

            {mode === 'batch' && <BatchTagBrowser store={store} onStoreUpdated={setStore} />}

            {mode === 'classify' && <BatchVisionClassifyBrowser store={store} onStoreUpdated={setStore} />}
          </>
        )
      })()}

      {mode !== 'categories' && !selectedBrowseLocation && (
        <p className="text-sm text-zinc-500">Select a location above to begin.</p>
      )}

      {mode === 'batch' && <BatchTagBrowser store={store} onStoreUpdated={setStore} />}

      {mode === 'classify' && <BatchVisionClassifyBrowser store={store} onStoreUpdated={setStore} />}
    </div>
  )
}
