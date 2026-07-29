'use client'

import { useEffect, useState } from 'react'
import { listFolder, viewUrl, jottaTime, type MountpointRef, type JottaFolderListing, type JottaEntry } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import { Thumbnail } from './Thumbnail'
import { KNOWN_CATEGORY_NAMES, type Category, type ArtworkTags } from '@/lib/metadata'
import {
  findMetadataSidecar,
  loadMetadataSidecar,
  deriveTagsFromMetadata,
  hasImportableTags,
  PHOTO_TAKEN_TIME_CATEGORY_ID,
  type GooglePhotosMetadata,
} from '@/lib/googlePhotosMetadata'
import {
  readArtworkMetadata,
  deriveTagsFromFileMetadata,
  DATE_ACQUIRED_CATEGORY_ID,
  EDITOR_CREATED_CATEGORY_ID,
  JOTTA_CREATED_CATEGORY_ID,
  type ArtworkFileMetadata,
} from '@/lib/imageMetadata'
import {
  classifyArtwork,
  tagsFromClassification,
  KNOWN_CLASSIFICATION_VALUES,
  CATEGORY_VALUE_LIMITS,
  type ArtworkClassification,
} from '@/lib/visionClassify'

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

type Sort = 'date-desc' | 'date-asc' | 'name'

// Jottacloud returns a folder in its own order, which is neither stable nor
// meaningful — hence sorting here rather than relying on it. Name uses a
// locale-aware numeric compare so "img2" precedes "img10".
function sortFiles(files: JottaEntry[], sort: Sort, dateOf: (f: JottaEntry) => number): JottaEntry[] {
  const sorted = [...files]
  switch (sort) {
    case 'date-desc':
      return sorted.sort((a, b) => dateOf(b) - dateOf(a))
    case 'date-asc':
      return sorted.sort((a, b) => dateOf(a) - dateOf(b))
    default:
      return sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
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
  // Which categories the file already used when the editor opened. Frozen at
  // that moment rather than tracking pendingTags live, so a category doesn't
  // leap to the top the instant you tag it and shift the buttons out from
  // under the cursor.
  const [initiallyTagged, setInitiallyTagged] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<Sort>('date-desc')

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
    const existingTags = existing?.tags ?? {}
    setPendingTags(existingTags)
    setInitiallyTagged(
      new Set(Object.keys(existingTags).filter((id) => (existingTags[id]?.length ?? 0) > 0))
    )
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
        const fileMetadata = await readArtworkMetadata(location, entry.path, { jottaCreated: entry.created })
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
      if (current.includes(value)) return { ...prev, [categoryId]: current.filter((v) => v !== value) }

      // At the limit, picking another drops the oldest rather than refusing
      // the click. For single-value categories that makes selection behave
      // like a radio group, which is what Subject/Palette/Framed want, and
      // for Style it beats hunting for which one to clear first.
      const limit = CATEGORY_VALUE_LIMITS[categoryId]
      const kept = limit && current.length >= limit ? current.slice(current.length - limit + 1) : current
      return { ...prev, [categoryId]: [...kept, value] }
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

  // Categories the file already carries come first, so what's set is visible
  // without scrolling past everything that isn't. Sort is stable, so within
  // each group the original order is preserved.
  const orderedCategories = [...effectiveCategories].sort(
    (a, b) => Number(!initiallyTagged.has(a.id)) - Number(!initiallyTagged.has(b.id))
  )

  // The best date this file has, in order of how much it actually tells you:
  // when the picture was taken, then when it was digitised, then when it
  // reached Jottacloud. The first two live in the tag store — reading them
  // off the files themselves would mean a range request each, whereas these
  // are already in memory. Untagged files fall through to Jottacloud's own
  // timestamp, which every file has.
  const tagsByMd5 = new Map(artworks.map((a) => [a.md5, a.tags]))
  function dateOf(file: JottaEntry): number {
    const tags = file.md5 ? tagsByMd5.get(file.md5) : undefined
    const stored =
      tags?.[PHOTO_TAKEN_TIME_CATEGORY_ID]?.[0] ??
      // For work made in an editor this is the creation date, so it ranks
      // directly behind a genuine capture time.
      tags?.[EDITOR_CREATED_CATEGORY_ID]?.[0] ??
      // Date Acquired sits between the two on purpose: when a piece was
      // digitised is far closer to when it was made than when it happened to
      // be uploaded, so skipping it would push files to the wrong end.
      tags?.[DATE_ACQUIRED_CATEGORY_ID]?.[0] ??
      tags?.[JOTTA_CREATED_CATEGORY_ID]?.[0]
    if (stored) {
      const parsed = Date.parse(stored)
      if (!Number.isNaN(parsed)) return parsed
    }
    return jottaTime(file.created)
  }

  // Whichever category the user made for titles — matched by name rather than
  // a hardcoded id, since it's one they created and could have called
  // anything close to "Title".
  const titleCategoryId = categories.find((c) => c.id === 'title' || c.name.trim().toLowerCase() === 'title')?.id

  function labelFor(file: JottaEntry): string {
    if (!titleCategoryId || !file.md5) return file.name
    return tagsByMd5.get(file.md5)?.[titleCategoryId]?.[0]?.trim() || file.name
  }

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
        <>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="date-desc">Date taken — newest</option>
            <option value="date-asc">Date taken — oldest</option>
            <option value="name">Name</option>
          </select>
          <span className="text-zinc-400">falls back to when the file reached Jottacloud</span>
        </div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {sortFiles(
            listing.files.filter((f) => f.md5 && !f.name.toLowerCase().endsWith('.json')),
            sort,
            dateOf
          ).map((f) => {
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
                    {/* The filename stays reachable on hover — it's still how
                        the file is identified everywhere else. */}
                    <span className="w-full truncate text-xs" title={f.name}>
                      {labelFor(f)}
                    </span>
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
        </>
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
            <h3 className="mb-1 truncate font-medium" title={editing.name}>
              {labelFor(editing)}
            </h3>
            {labelFor(editing) !== editing.name && (
              <p className="mb-1 truncate text-xs text-zinc-400">{editing.name}</p>
            )}

            {/* The tag list is long enough to scroll past the filename, and
                the point of tagging is what the picture looks like — so keep
                it in view. Clicking opens the full-size viewer. */}
            {location && (
              <a
                href={viewUrl(location, editing.path)}
                target="_blank"
                rel="noreferrer"
                className="mb-3 block"
                title="Open full size"
              >
                <Thumbnail
                  loc={location}
                  path={editing.path}
                  alt={editing.name}
                  px={512}
                  className="mx-auto max-h-48 w-auto rounded object-contain"
                />
              </a>
            )}

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
                {filePropsPreview.sourceType && (
                  <p className="font-medium text-indigo-700 dark:text-indigo-400">
                    🔏 Content credentials: {filePropsPreview.sourceType}
                  </p>
                )}
                {/* How the piece was worked on, from the editor's own record.
                    Shown rather than tagged: one-off numbers per file would
                    sprawl the pickers without helping you browse. */}
                {filePropsPreview.editorDrawTimeMs != null && filePropsPreview.editorDrawTimeMs > 0 && (
                  <p>
                    ✍️ Drawing time:{' '}
                    {filePropsPreview.editorDrawTimeMs < 60000
                      ? `${Math.round(filePropsPreview.editorDrawTimeMs / 1000)} sec`
                      : `${Math.round(filePropsPreview.editorDrawTimeMs / 60000)} min`}
                    {filePropsPreview.editorDrawActions != null && ` · ${filePropsPreview.editorDrawActions} strokes`}
                    {filePropsPreview.editorBrushesUsed != null && ` · ${filePropsPreview.editorBrushesUsed} brushes`}
                    {filePropsPreview.editorLayersUsed != null && ` · ${filePropsPreview.editorLayersUsed} layers`}
                  </p>
                )}
                {filePropsPreview.editorPhotosAdded != null && (
                  <p>
                    🖼️ {filePropsPreview.editorPhotosAdded > 0
                      ? `Includes ${filePropsPreview.editorPhotosAdded} photo(s)`
                      : 'Fully drawn — no photo used'}
                  </p>
                )}
                {filePropsPreview.editorCanvasWidth != null &&
                  filePropsPreview.editorCanvasHeight != null &&
                  filePropsPreview.width != null &&
                  filePropsPreview.editorCanvasWidth !== filePropsPreview.width && (
                    <p className="text-zinc-400">
                      ⤢ Drawn at {filePropsPreview.editorCanvasWidth} × {filePropsPreview.editorCanvasHeight}, exported
                      at {filePropsPreview.width} × {filePropsPreview.height}
                    </p>
                  )}
                {filePropsPreview.editorCreatedAtEpochSeconds != null && (
                  <p>
                    🎨 Created in editor:{' '}
                    {new Date(filePropsPreview.editorCreatedAtEpochSeconds * 1000).toISOString().slice(0, 10)}
                  </p>
                )}
                {filePropsPreview.fileChangedAtEpochSeconds != null && (
                  <p>
                    ✏️ Changed:{' '}
                    {new Date(filePropsPreview.fileChangedAtEpochSeconds * 1000).toISOString().slice(0, 10)}
                  </p>
                )}
                {filePropsPreview.jottaCreatedAtEpochSeconds != null && (
                  <p>
                    ☁️ Added to Jottacloud:{' '}
                    {new Date(filePropsPreview.jottaCreatedAtEpochSeconds * 1000).toISOString().slice(0, 10)}
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
                  🎨 {classifyResult.style.join(' + ')} · {classifyResult.subject} · {classifyResult.palette} ·{' '}
                  {classifyResult.framed === 'Yes' ? 'Framed' : 'Unframed'} · {classifyResult.mood.join(' + ')} ·{' '}
                  {classifyResult.motion}
                  {classifyResult.figures && classifyResult.figures.length > 0 && (
                    <span className="ml-1">· sees {classifyResult.figures.join(', ')}</span>
                  )}
                  {classifyResult.observation && (
                    <span className="mt-1 block italic text-zinc-500 dark:text-zinc-500">
                      “{classifyResult.observation}”
                    </span>
                  )}
                  {classifyResult.suggestedStyle && (
                    <span className="ml-1 text-amber-700 dark:text-amber-400">
                      · suggests “{classifyResult.suggestedStyle}”
                    </span>
                  )}
                </p>
              )}
            </div>

            {effectiveCategories.length === 0 && (
              <p className="text-sm text-zinc-500">No categories defined yet — add some in the Categories tab first.</p>
            )}
            {(() => {
              const total = Object.values(pendingTags).reduce((n, values) => n + (values?.length ?? 0), 0)
              if (total === 0) return null
              return (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">
                    {total} tag{total === 1 ? '' : 's'} on this file
                  </span>
                  <button
                    onClick={() => setPendingTags({})}
                    className="text-xs text-red-600 hover:underline dark:text-red-400"
                  >
                    Clear all
                  </button>
                </div>
              )
            })()}
            <div className="flex flex-col gap-3">
              {/* Every category is offered here, including ones with no
                  values yet — this is where tags are authored, so a category
                  you just created has to be reachable. Browse still hides
                  empty ones, where there is nothing to filter by. */}
              {orderedCategories.map((category) => {
                  const activeValues = pendingTags[category.id] ?? []
                  // A fixed closed list always shows its full picker, however
                  // many values it holds. The threshold is for open-ended
                  // categories like People or Year that gain a value per
                  // photo — applying it to a list of ten would just replace
                  // the buttons with a box you'd have to type exact names into.
                  const isClosedList = !!KNOWN_CLASSIFICATION_VALUES[category.id]
                  const isLarge = !isClosedList && category.values.length > LARGE_CATEGORY_THRESHOLD

                  // Open categories always get the text box, whatever their
                  // size. Without it a new category (or any category whose
                  // values you haven't created yet) is visible but unusable.
                  const addInput = (
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
                        placeholder={category.values.length === 0 ? `Type a ${category.name.toLowerCase()}…` : 'Add a value…'}
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
                  )
                  return (
                  <div key={category.id}>
                    <p className="mb-1 text-xs font-medium text-zinc-500">
                      {category.name}
                      {(CATEGORY_VALUE_LIMITS[category.id] ?? 0) > 1 && (
                        <span className="ml-1 font-normal text-zinc-400">
                          (up to {CATEGORY_VALUE_LIMITS[category.id]})
                        </span>
                      )}
                    </p>
                    {category.freeText ? (
                      // One field holding this file's own wording. No Add
                      // button: the text *is* the value, and there's nothing
                      // to accumulate.
                      <input
                        value={activeValues[0] ?? ''}
                        onChange={(e) => {
                          const text = e.target.value
                          setPendingTags((prev) => ({ ...prev, [category.id]: text.trim() ? [text] : [] }))
                        }}
                        placeholder={`${category.name}…`}
                        className="w-full rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                      />
                    ) : isLarge ? (
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
                        {addInput}
                        <p className="text-[11px] text-zinc-400">
                          {category.values.length} values in this category — too many to list, showing only this
                          file&rsquo;s.
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {category.values.length > 0 && (
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
                          </div>
                        )}
                        {!isClosedList && addInput}
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
