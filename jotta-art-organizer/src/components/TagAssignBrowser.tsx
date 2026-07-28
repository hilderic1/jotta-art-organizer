'use client'

import { useEffect, useState } from 'react'
import { listFolder, viewUrl, type MountpointRef, type JottaFolderListing, type JottaEntry } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import { Thumbnail } from './Thumbnail'
import { KNOWN_CATEGORY_NAMES, type Category, type ArtworkTags } from '@/lib/metadata'
import {
  findMetadataSidecar,
  loadMetadataSidecar,
  deriveTagsFromMetadata,
  hasImportableTags,
  type GooglePhotosMetadata,
} from '@/lib/googlePhotosMetadata'
import { readArtworkMetadata, deriveTagsFromFileMetadata, type ArtworkFileMetadata } from '@/lib/imageMetadata'
import {
  classifyArtwork,
  tagsFromClassification,
  KNOWN_CLASSIFICATION_VALUES,
  type ArtworkClassification,
} from '@/lib/visionClassify'

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

// Categories fed by auto-derived metadata (dates, coordinates, eventually
// People too) can grow to one distinct value per photo — listing every
// value as a pill becomes unusable well before that. Past this size, show
// only the current file's own value(s) plus a way to add one, instead of
// the full list.
const LARGE_CATEGORY_THRESHOLD = 10

export function TagAssignBrowser({
  categories,
  artworks,
  onSave,
  initialLocation,
}: {
  categories: Category[]
  artworks: ArtworkTags[]
  onSave: (entry: JottaEntry, loc: MountpointRef, tags: Record<string, string[]>) => Promise<void>
  initialLocation?: (MountpointRef & { path?: string }) | null
}) {
  const [location, setLocation] = useState<MountpointRef | null>(initialLocation ? { device: initialLocation.device, mountpoint: initialLocation.mountpoint } : null)
  const [path, setPath] = useState(initialLocation?.path ?? '')
  const [listing, setListing] = useState<JottaFolderListing | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)
  const [editing, setEditing] = useState<JottaEntry | null>(null)
  const [pendingTags, setPendingTags] = useState<Record<string, string[]>>({})
  const [newValueDrafts, setNewValueDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [metadataPreview, setMetadataPreview] = useState<GooglePhotosMetadata | null>(null)
  const [filePropsPreview, setFilePropsPreview] = useState<ArtworkFileMetadata | null>(null)
  const [metadataAttempted, setMetadataAttempted] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [classifyError, setClassifyError] = useState<string | null>(null)
  const [classifyResult, setClassifyResult] = useState<ArtworkClassification | null>(null)

  useEffect(() => {
    if (!location) return
    let ignore = false
    listFolder(location, path)
      .then((data) => {
        if (!ignore) {
          setListing(data)
          setListingError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setListingError(err instanceof Error ? err.message : 'Failed to load folder.')
      })
    return () => {
      ignore = true
    }
  }, [location, path])

  function openEditor(entry: JottaEntry) {
    const existing = entry.md5 ? artworks.find((a) => a.md5 === entry.md5) : undefined
    setPendingTags(existing?.tags ?? {})
    setNewValueDrafts({})
    setEditing(entry)
    setMetadataPreview(null)
    setFilePropsPreview(null)
    setMetadataAttempted(false)
    setClassifyError(null)
    setClassifyResult(null)
    setSaveError(null)

    if (!location) return
    setMetadataLoading(true)
    // Includes soft-deleted siblings and tries every filename sharing this
    // photo's content hash, not just its own — the same reasoning as the
    // batch importer: a sidecar can only pair with one of a set of
    // duplicate filenames, and dedupe may have kept a different one.
    listFolder(location, path, { includeDeleted: true })
      .then(async (extendedListing) => {
        const namesToTry = entry.md5
          ? [...new Set(extendedListing.files.filter((f) => f.md5 === entry.md5).map((f) => f.name))]
          : [entry.name]
        const sidecar = namesToTry.map((name) => findMetadataSidecar(extendedListing.files, name)).find(Boolean)
        const googleMetadata = sidecar ? await loadMetadataSidecar(location, sidecar) : null
        if (googleMetadata) return { google: googleMetadata, file: null }
        // Most artwork (as opposed to actual photos) has no Google Photos
        // sidecar at all — fall back to whatever the file's own embedded
        // properties (dimensions, resolution, date) can tell us.
        const fileMetadata = await readArtworkMetadata(location, entry.path)
        return { google: null, file: fileMetadata }
      })
      .then((result) => {
        setMetadataPreview(result.google)
        setFilePropsPreview(result.file)
      })
      .catch(() => {
        setMetadataPreview(null)
        setFilePropsPreview(null)
      })
      .finally(() => {
        setMetadataLoading(false)
        setMetadataAttempted(true)
      })
  }

  function useMetadataAsTags() {
    if (!metadataPreview) return
    setPendingTags((prev) => deriveTagsFromMetadata(metadataPreview, prev))
  }

  function useFilePropsAsTags() {
    if (!filePropsPreview) return
    setPendingTags((prev) => deriveTagsFromFileMetadata(filePropsPreview, prev))
  }

  async function handleClassify() {
    if (!editing || !location) return
    setClassifying(true)
    setClassifyError(null)
    try {
      const result = await classifyArtwork(location, editing.path)
      setClassifyResult(result)
      setPendingTags((prev) => tagsFromClassification(result, prev))
    } catch (err) {
      setClassifyError(err instanceof Error ? err.message : 'Failed to classify.')
    } finally {
      setClassifying(false)
    }
  }

  function toggleValue(categoryId: string, value: string) {
    setPendingTags((prev) => {
      const current = prev[categoryId] ?? []
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
      return { ...prev, [categoryId]: next }
    })
  }

  function addValue(categoryId: string, rawValue: string) {
    const value = rawValue.trim()
    if (!value) return
    setPendingTags((prev) => {
      const current = prev[categoryId] ?? []
      if (current.includes(value)) return prev
      return { ...prev, [categoryId]: [...current, value] }
    })
    setNewValueDrafts((prev) => ({ ...prev, [categoryId]: '' }))
  }

  async function handleSave() {
    if (!editing || !location) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(editing, location, pendingTags)
      setEditing(null)
    } catch (err) {
      // Keep the modal open on failure — closing unconditionally here used
      // to hide the fact that the upload to Jottacloud never completed.
      setSaveError(err instanceof Error ? err.message : 'Failed to save tags.')
    } finally {
      setSaving(false)
    }
  }

  // Merges in a synthetic entry for any pendingTags key not yet backed by a
  // real category — e.g. AI classification's Style/Subject/Palette/Framed/
  // Mood the very first time it's ever used, before any save has created
  // the category. Without this, a value the AI (or file-property parsing)
  // just assigned was invisible and impossible to review or change before
  // saving.
  const effectiveCategories: Category[] = [
    ...categories,
    ...Object.keys(pendingTags)
      .filter((id) => (pendingTags[id]?.length ?? 0) > 0 && !categories.some((c) => c.id === id))
      .map((id) => ({
        id,
        name: KNOWN_CATEGORY_NAMES[id] ?? id,
        values: [...new Set([...(KNOWN_CLASSIFICATION_VALUES[id] ?? []), ...(pendingTags[id] ?? [])])],
      })),
  ]

  const crumbs = segments(path)

  if (!location) {
    return (
      <LocationPicker
        onSelect={(loc) => {
          setLocation(loc)
          setPath('')
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <button
          className="text-zinc-500 hover:underline"
          onClick={() => {
            setLocation(null)
            setListing(null)
          }}
        >
          « Locations
        </button>
        <span className="text-zinc-400">/</span>
        <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setPath('')}>
          {location.mountpoint}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-zinc-400">/</span>
            <button
              className="text-indigo-600 hover:underline dark:text-indigo-400"
              onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {listingError && <p className="text-sm text-red-600 dark:text-red-400">{listingError}</p>}
      {!listing && !listingError && <p className="text-sm text-zinc-500">Loading…</p>}

      {listing && listing.folders.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          {listing.folders.map((f) => (
            <li key={f.path}>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:text-indigo-600 dark:hover:text-indigo-400"
                onClick={() => setPath([...crumbs, f.name].join('/'))}
              >
                📁 {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {listing && listing.files.filter((f) => f.md5 && !f.name.toLowerCase().endsWith('.json')).length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {listing.files
            .filter((f) => f.md5 && !f.name.toLowerCase().endsWith('.json'))
            .map((f) => {
              const tagged = artworks.find((a) => a.md5 === f.md5)
              const tagCount = tagged ? Object.values(tagged.tags).flat().length : 0
              const hasMetadata = Boolean(findMetadataSidecar(listing.files, f.name))
              return (
                <li key={f.path}>
                  <button
                    className="flex w-full flex-col items-center gap-1 rounded-lg border border-zinc-200 p-2 text-center hover:border-indigo-400 dark:border-zinc-800"
                    onClick={() => openEditor(f)}
                  >
                    <div className="relative">
                      <Thumbnail loc={location} path={f.path} alt={f.name} px={256} className="h-20 w-20 rounded object-cover" />
                      {hasMetadata && (
                        <span
                          title="Has Google Photos metadata"
                          className="absolute -right-1 -top-1 rounded-full bg-white text-xs leading-none dark:bg-zinc-900"
                        >
                          📋
                        </span>
                      )}
                    </div>
                    <span className="w-full truncate text-xs">{f.name}</span>
                    {tagCount > 0 && (
                      <span className="text-xs text-indigo-600 dark:text-indigo-400">
                        {tagCount} tag{tagCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
        </ul>
      )}

      {editing && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 truncate font-medium">{editing.name}</h3>

            {metadataLoading && <p className="mb-3 text-xs text-zinc-500">Checking for Google Photos metadata…</p>}
            {metadataAttempted && !metadataLoading && !metadataPreview && !filePropsPreview && (
              <p className="mb-3 text-xs text-zinc-400">No Google Photos metadata or readable file properties found.</p>
            )}
            {!metadataPreview && filePropsPreview && (
              <div className="mb-3 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                <p className="mb-1 font-medium text-zinc-500">File properties</p>
                {filePropsPreview.width != null && filePropsPreview.height != null && (
                  <p>
                    📐 {filePropsPreview.width} × {filePropsPreview.height}
                  </p>
                )}
                {(filePropsPreview.xResolution != null || filePropsPreview.yResolution != null) && (
                  <p>
                    🔍 {filePropsPreview.xResolution ?? '?'} × {filePropsPreview.yResolution ?? '?'} DPI
                  </p>
                )}
                {filePropsPreview.dateTakenAtEpochSeconds != null && (
                  <p>
                    📅 Taken: {new Date(filePropsPreview.dateTakenAtEpochSeconds * 1000).toISOString().slice(0, 10)}
                  </p>
                )}
                {filePropsPreview.dateAcquiredAtEpochSeconds != null && (
                  <p>
                    📥 Acquired: {new Date(filePropsPreview.dateAcquiredAtEpochSeconds * 1000).toISOString().slice(0, 10)}
                  </p>
                )}
                {filePropsPreview.authors && filePropsPreview.authors.length > 0 && (
                  <p>🖋️ {filePropsPreview.authors.join(', ')}</p>
                )}
                {filePropsPreview.programName && <p>💻 Program: {filePropsPreview.programName}</p>}
                {filePropsPreview.copyright && <p>© {filePropsPreview.copyright}</p>}
                <div className="mt-1">
                  <button
                    onClick={useFilePropsAsTags}
                    className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                  >
                    Use as tags
                  </button>
                </div>
              </div>
            )}
            {metadataPreview && (
              <div className="mb-3 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                <p className="mb-1 font-medium text-zinc-500">Google Photos metadata</p>
                {metadataPreview.photoTakenTime && <p>📅 Taken: {metadataPreview.photoTakenTime}</p>}
                {metadataPreview.creationTime && <p>⬆️ Uploaded: {metadataPreview.creationTime}</p>}
                {metadataPreview.favorited && <p>⭐ Favorited</p>}
                {metadataPreview.people.length > 0 && <p>🧑 {metadataPreview.people.join(', ')}</p>}
                {metadataPreview.source && <p>📱 Source: {metadataPreview.source}</p>}
                {metadataPreview.latitude != null && metadataPreview.longitude != null && (
                  <p>
                    📍 {metadataPreview.latitude.toFixed(5)}, {metadataPreview.longitude.toFixed(5)}
                  </p>
                )}
                {metadataPreview.description && <p>💬 {metadataPreview.description}</p>}
                {metadataPreview.url && (
                  <p>
                    <a
                      href={metadataPreview.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      🔗 View on Google Photos
                    </a>
                  </p>
                )}
                {hasImportableTags(metadataPreview) && (
                  <div className="mt-1">
                    <button
                      onClick={useMetadataAsTags}
                      className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      Use as tags
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="mb-3 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
              <p className="mb-1 font-medium text-zinc-500">AI classification</p>
              <button
                disabled={classifying}
                onClick={handleClassify}
                className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {classifying ? 'Classifying…' : '✨ Classify with AI'}
              </button>
              {classifyError && <p className="mt-1 text-red-600 dark:text-red-400">{classifyError}</p>}
              {classifyResult && (
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  🎨 {classifyResult.style} · {classifyResult.subject} · {classifyResult.palette} ·{' '}
                  {classifyResult.framed === 'Yes' ? 'Framed' : 'Unframed'} · {classifyResult.mood}
                </p>
              )}
            </div>

            {effectiveCategories.length === 0 && (
              <p className="text-sm text-zinc-500">No categories defined yet — add some in the Categories tab first.</p>
            )}
            <div className="flex flex-col gap-3">
              {effectiveCategories
                .filter((cat) => cat.values.length > 0)
                .map((category) => {
                  const activeValues = pendingTags[category.id] ?? []
                  const isLarge = category.values.length > LARGE_CATEGORY_THRESHOLD
                  return (
                  <div key={category.id}>
                    <p className="mb-1 text-xs font-medium text-zinc-500">{category.name}</p>
                    {isLarge ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          {activeValues.length === 0 && (
                            <span className="text-xs text-zinc-400">No value set for this file.</span>
                          )}
                          {activeValues.map((value) => (
                            <button
                              key={value}
                              onClick={() => toggleValue(category.id, value)}
                              className="rounded-full bg-indigo-600 px-3 py-1 text-xs text-white"
                            >
                              {value} ✕
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            list={`category-${category.id}-values`}
                            value={newValueDrafts[category.id] ?? ''}
                            onChange={(e) => setNewValueDrafts((prev) => ({ ...prev, [category.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                addValue(category.id, newValueDrafts[category.id] ?? '')
                              }
                            }}
                            placeholder="Add a value…"
                            className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                          />
                          <datalist id={`category-${category.id}-values`}>
                            {category.values.map((value) => (
                              <option key={value} value={value} />
                            ))}
                          </datalist>
                          <button
                            onClick={() => addValue(category.id, newValueDrafts[category.id] ?? '')}
                            className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          >
                            Add
                          </button>
                        </div>
                        <p className="text-[11px] text-zinc-400">
                          {category.values.length} values in this category — too many to list, showing only this
                          file&rsquo;s.
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {category.values.map((value) => {
                          const active = activeValues.includes(value)
                          return (
                            <button
                              key={value}
                              onClick={() => toggleValue(category.id, value)}
                              className={`rounded-full px-3 py-1 text-xs ${
                                active
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                              }`}
                            >
                              {value}
                            </button>
                          )
                        })}
                        {category.values.length === 0 && <span className="text-xs text-zinc-400">No values defined.</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {saveError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{saveError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button className="text-sm text-zinc-500" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                disabled={saving}
                onClick={handleSave}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save tags'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
