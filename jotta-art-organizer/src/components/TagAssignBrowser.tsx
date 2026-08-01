'use client'

import { useEffect, useMemo, useState } from 'react'
import { listFolder, jottaTime, type MountpointRef, type JottaFolderListing, type JottaEntry } from '@/lib/api'
import { LocationPicker } from './LocationPicker'
import { Thumbnail } from './Thumbnail'
import { ImageViewer } from './ImageViewer'
import { FileProperties } from './FileProperties'
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

type Sort = 'date-desc' | 'date-asc' | 'modified-desc' | 'name'

// Jottacloud returns a folder in its own order, which is neither stable nor
// meaningful — hence sorting here rather than relying on it. Name uses a
// locale-aware numeric compare so "img2" precedes "img10".
function changedAt(file: JottaEntry): number {
  return jottaTime(file.modified) || jottaTime(file.created)
}

function sortFiles(files: JottaEntry[], sort: Sort, dateOf: (f: JottaEntry) => number): JottaEntry[] {
  const sorted = [...files]
  switch (sort) {
    case 'date-desc':
      return sorted.sort((a, b) => dateOf(b) - dateOf(a))
    case 'date-asc':
      return sorted.sort((a, b) => dateOf(a) - dateOf(b))
    // Straight off the listing rather than the tag store, so this one answers
    // "what have I touched lately" without needing an import first. Files with
    // no modified time fall back to when they arrived: on the same clock, and
    // for a file never touched since upload, arriving *is* the last change.
    // Deliberately not the creation chain — EXIF and C2PA dates describe when
    // the picture was made, which would strand old work uploaded recently.
    case 'modified-desc':
      return sorted.sort((a, b) => changedAt(b) - changedAt(a))
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

// A folder of several hundred pictures built a tile for every one of them,
// and rebuilt them all whenever anything changed. Rendered a page at a time
// instead — lazy loading already kept the images off the wire, but the DOM
// itself was the cost on a phone.
const FILES_PER_PAGE = 100

// Read from the file rather than decided by you. Editable, but rarely edited
// — so they're tucked behind one collapsed heading instead of taking two
// thirds of the dialog before the first thing you actually choose.
const READ_FROM_FILE_IDS = new Set([
  'people',
  'favorited',
  'year',
  'photoTakenTime',
  'creationTime',
  'geoData',
  'source',
  'dateAcquired',
  'jottaCreated',
  'fileChanged',
  'editorCreated',
  'sourceType',
  'credit',
  'photoUsed',
  'drawTime',
  'programName',
  'copyright',
])

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
  // A path rather than a flag: the viewer also opens the linked original,
  // which is a different file from the one being edited.
  const [viewingPath, setViewingPath] = useState<string | null>(null)
  // What's typed into the Enhanced from field while picking. Null means not
  // picking — the field then shows the linked original's title rather than
  // the hash actually stored.
  const [derivedSearch, setDerivedSearch] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(FILES_PER_PAGE)

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

  useEffect(() => {
    setVisibleCount(FILES_PER_PAGE)
  }, [listing, sort])

  function openEditor(entry: JottaEntry) {
    const existing = entry.md5 ? artworks.find((a) => a.md5 === entry.md5) : undefined
    const existingTags = existing?.tags ?? {}
    setPendingTags(existingTags)
    setInitiallyTagged(
      new Set(Object.keys(existingTags).filter((id) => (existingTags[id]?.length ?? 0) > 0))
    )
    setNewValueDrafts({})
    setDerivedSearch(null)
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
        // Both, not one or the other. They know different things: the sidecar
        // has the people, the star and where Google got it; the file has the
        // camera, the exposure and its own coordinates. Reading both costs one
        // extra fetch for the single photo being opened — the reason batch
        // tagging still picks one, where it would mean a fetch per file.
        const [googleMetadata, fileMetadata] = await Promise.all([
          sidecar ? loadMetadataSidecar(location, sidecar) : Promise.resolve(null),
          readArtworkMetadata(location, entry.path, { jottaCreated: entry.created }),
        ])
        return { google: googleMetadata, file: fileMetadata }
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
  // Offered on every file rather than waiting to be created in Categories:
  // linking an enhanced piece to the original is the point of the feature,
  // and a category you have to invent first would never get used.
  // Always free text, whatever produced its category entry. Both the
  // synthesised entry above and a saved one carry no freeText flag, so the
  // moment a link was set the row switched to pills — the original showed as
  // a bare tag, with no field to edit and nowhere for the thumbnail to go.
  const withDerivedFrom: Category[] = effectiveCategories.some((c) => c.id === 'derivedFrom')
    ? effectiveCategories.map((c) =>
        c.id === 'derivedFrom'
          ? { ...c, name: KNOWN_CATEGORY_NAMES.derivedFrom, values: [], freeText: true }
          : c
      )
    : [
        ...effectiveCategories,
        { id: 'derivedFrom', name: KNOWN_CATEGORY_NAMES.derivedFrom, values: [], freeText: true },
      ]

  const orderedCategories = useMemo(
    () =>
      [...withDerivedFrom].sort(
        (a, b) => Number(!initiallyTagged.has(a.id)) - Number(!initiallyTagged.has(b.id))
      ),
    [withDerivedFrom, initiallyTagged]
  )

  // The best date this file has, in order of how much it actually tells you:
  // when the picture was taken, then when it was digitised, then when it
  // reached Jottacloud. The first two live in the tag store — reading them
  // off the files themselves would mean a range request each, whereas these
  // are already in memory. Untagged files fall through to Jottacloud's own
  // timestamp, which every file has.
  const artworkByMd5 = useMemo(() => new Map(artworks.map((a) => [a.md5, a])), [artworks])

  const tagsByMd5 = useMemo(() => new Map(artworks.map((a) => [a.md5, a.tags])), [artworks])
  // Resolved once per file and cached, not recomputed inside the sort
  // comparator — that ran Date.parse on every comparison, so an n log n sort
  // became n log n date parses on every keystroke.
  const dateByMd5 = useMemo(() => {
    const dates = new Map<string, number>()
    for (const [md5, tags] of tagsByMd5) {
      const stored =
        tags?.[PHOTO_TAKEN_TIME_CATEGORY_ID]?.[0] ??
        tags?.[EDITOR_CREATED_CATEGORY_ID]?.[0] ??
        tags?.[DATE_ACQUIRED_CATEGORY_ID]?.[0] ??
        tags?.[JOTTA_CREATED_CATEGORY_ID]?.[0]
      if (!stored) continue
      const parsed = Date.parse(stored)
      if (!Number.isNaN(parsed)) dates.set(md5, parsed)
    }
    return dates
  }, [tagsByMd5])

  function dateOf(file: JottaEntry): number {
    const known = file.md5 ? dateByMd5.get(file.md5) : undefined
    return known ?? jottaTime(file.created)
  }

  // Whichever category the user made for titles — matched by name rather than
  // a hardcoded id, since it's one they created and could have called
  // anything close to "Title".
  const titleCategoryId = categories.find((c) => c.id === 'title' || c.name.trim().toLowerCase() === 'title')?.id

  function titleFor(file: JottaEntry): string | undefined {
    if (!titleCategoryId || !file.md5) return undefined
    return tagsByMd5.get(file.md5)?.[titleCategoryId]?.[0]?.trim() || undefined
  }

  function labelFor(file: JottaEntry): string {
    return titleFor(file) ?? file.name
  }

  // Sorted once per listing rather than on every render, and with the two
  // per-file scans that were inside the grid — a linear search of every
  // artwork, and a sidecar match against every sibling file — hoisted into
  // maps built once. Both were quadratic against folder size on each render.
  const visibleFiles = useMemo(() => {
    const files = listing?.files ?? []
    return sortFiles(
      files.filter((f) => f.md5 && !f.name.toLowerCase().endsWith('.json')),
      sort,
      dateOf
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dateOf is derived from dateByMd5
  }, [listing, sort, dateByMd5])

  // Suggestions for the Enhanced from picker: this folder's pictures, minus
  // the piece being edited, matched on filename or title. Capped because the
  // list carries a thumbnail per row — enough to scroll through, not enough
  // to fetch a folder's worth of images to fill a dropdown.
  const derivedMatches = useMemo(() => {
    const query = (derivedSearch ?? '').trim().toLowerCase()
    return visibleFiles
      .filter((f) => f.path !== editing?.path && f.md5)
      .filter(
        (f) =>
          !query ||
          f.name.toLowerCase().includes(query) ||
          (titleFor(f)?.toLowerCase().includes(query) ?? false)
      )
      // Newest first regardless of how the grid is sorted: an original is
      // almost always something worked on recently, so it should be near the
      // top before a single character is typed.
      .sort((a, b) => changedAt(b) - changedAt(a))
      .slice(0, 30)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titleFor is derived from tagsByMd5
  }, [visibleFiles, derivedSearch, editing, tagsByMd5])

  const tagCountByMd5 = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [md5, tags] of tagsByMd5) counts.set(md5, Object.values(tags).flat().length)
    return counts
  }, [tagsByMd5])

  const namesWithSidecar = useMemo(() => {
    const files = listing?.files ?? []
    const found = new Set<string>()
    for (const f of files) {
      if (f.md5 && !f.name.toLowerCase().endsWith('.json') && findMetadataSidecar(files, f.name)) found.add(f.name)
    }
    return found
  }, [listing])

  // Stored as the original's content hash so renaming it doesn't break the
  // link, resolved to its title — or failing that its filename — for display.
  // A hash is durable and unreadable; a name is readable and fragile.
  function labelForMd5(md5: string): string {
    const known = artworkByMd5.get(md5)
    const title = titleCategoryId ? known?.tags?.[titleCategoryId]?.[0]?.trim() : undefined
    if (title) return title
    const inFolder = listing?.files.find((f) => f.md5 === md5)
    return inFolder?.name ?? known?.path.split('/').pop() ?? md5
  }

  // The linked original as a file we can show: in this folder if it's here,
  // otherwise wherever the tag store last saw it.
  function originalFor(value: string): { path: string; name: string } | null {
    const here = listing?.files.find((f) => f.md5 === value)
    if (here) return { path: here.path, name: here.name }
    const known = artworkByMd5.get(value)
    if (known) return { path: known.path, name: known.path.split('/').pop() ?? value }
    // Not a hash: a name typed by hand, or a link made before hashes were
    // stored. Still worth showing if the folder has a file by that name.
    const named = listing?.files.find((f) => f.name === value || labelFor(f) === value)
    if (named) return { path: named.path, name: named.name }
    return null
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
            <option value="date-desc">Created — newest</option>
            <option value="date-asc">Created — oldest</option>
            <option value="modified-desc">Recently changed</option>
            <option value="name">Name</option>
          </select>
          <span className="text-zinc-400">
            {sort === 'modified-desc'
              ? 'when the file last changed, or arrived if never changed'
              : 'taken, then created, then when the file reached Jottacloud'}
          </span>
        </div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visibleFiles.slice(0, visibleCount).map((f) => {
              const tagCount = (f.md5 && tagCountByMd5.get(f.md5)) || 0
              const hasMetadata = namesWithSidecar.has(f.name)
              return (
                <li key={f.path}>
                  <button
                    className="flex w-full flex-col items-center gap-1 rounded-lg border border-zinc-200 p-2 text-center hover:border-indigo-400 dark:border-zinc-800"
                    onClick={() => openEditor(f)}
                  >
                    <div className="relative">
                      <Thumbnail loc={location} path={f.path} alt={f.name} px={128} className="h-20 w-20 rounded object-cover" />
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
        {visibleFiles.length > visibleCount && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setVisibleCount((n) => n + FILES_PER_PAGE)}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Show more
            </button>
            <span className="text-xs text-zinc-400">
              showing {visibleCount} of {visibleFiles.length}
            </span>
          </div>
        )}
        </>
      )}

      {editing && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditing(null)}
        >
          {/* Header and actions are pinned, the middle scrolls. Cancel used to
              sit below two dozen categories, so leaving the dialog on a phone
              meant scrolling the whole way down first. */}
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-white dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
              <div className="min-w-0">
                <h3 className="truncate font-medium" title={editing.name}>
                  {labelFor(editing)}
                </h3>
                {labelFor(editing) !== editing.name && (
                  <p className="truncate text-xs text-zinc-400">{editing.name}</p>
                )}
              </div>
              <button
                onClick={() => setEditing(null)}
                className="shrink-0 rounded px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
            {/* Picture and what the file says, side by side: the properties
                used to push every tag another screen down. */}
            {location && (
              <div className="mb-3 flex gap-3">
                {/* Opens the in-app viewer rather than linking to the raw
                    file: installed as a home-screen app there is no browser
                    chrome, so a new tab showing an image has nothing to close
                    it with. */}
                <button onClick={() => setViewingPath(editing.path)} className="shrink-0" title="Open full size">
                  <Thumbnail
                    loc={location}
                    path={editing.path}
                    alt={editing.name}
                    px={512}
                    className="max-h-40 w-32 rounded object-contain"
                  />
                </button>
                <div className="min-w-0 flex-1">
                  {filePropsPreview && (
                    <>
                      <FileProperties meta={filePropsPreview} />
                      <button
                        onClick={useFilePropsAsTags}
                        className="mt-1 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                      >
                        Use as tags
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {metadataLoading && <p className="mb-3 text-xs text-zinc-500">Checking for Google Photos metadata…</p>}
            {metadataAttempted && !metadataLoading && !metadataPreview && !filePropsPreview && (
              <p className="mb-3 text-xs text-zinc-400">No Google Photos metadata or readable file properties found.</p>
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
                  🎨 {classifyResult.style.join(' + ')} · {classifyResult.subject} ·{' '}
                  {classifyResult.framed === 'Yes' ? 'Framed' : 'Unframed'}
                  {classifyResult.figures && classifyResult.figures.length > 0 && (
                    <span className="ml-1">· sees {classifyResult.figures.join(', ')}</span>
                  )}
                  {classifyResult.observation && (
                    <span className="mt-1 block italic text-zinc-500 dark:text-zinc-500">
                      “{classifyResult.observation}”
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
              {orderedCategories.filter((c) => !READ_FROM_FILE_IDS.has(c.id)).map((category) => {
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
                        {(category.id === 'derivedFrom' ? visibleFiles.map((f) => f.name) : category.values).map((value) => (
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
                  // Label in a fixed column with its values beside it, rather
                  // than a heading above them: a stack of two dozen
                  // heading-then-pills blocks is what made this unreadable.
                  <div key={category.id} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                    <p className="shrink-0 text-xs font-medium text-zinc-500 sm:w-20 sm:text-right">
                      {category.name}
                      {(CATEGORY_VALUE_LIMITS[category.id] ?? 0) > 1 && (
                        <span className="ml-1 font-normal text-zinc-400">
                          ({CATEGORY_VALUE_LIMITS[category.id]})
                        </span>
                      )}
                    </p>
                    <div className="min-w-0 flex-1">
                    {category.freeText ? (
                      // One field holding this file's own wording. No Add
                      // button: the text *is* the value, and there's nothing
                      // to accumulate.
                      <>
                      <div className="relative flex items-center gap-2">
                      <input
                        value={
                          category.id === 'derivedFrom'
                            ? derivedSearch ?? (activeValues[0] ? labelForMd5(activeValues[0]) : '')
                            : activeValues[0] ?? ''
                        }
                        onFocus={() => {
                          if (category.id === 'derivedFrom') setDerivedSearch('')
                        }}
                        // A click on a suggestion blurs the input first, which
                        // would close the list before the click landed. The
                        // rows suppress that blur, so this only fires when
                        // focus really leaves the field.
                        onBlur={() => {
                          if (category.id === 'derivedFrom') setDerivedSearch(null)
                        }}
                        onChange={(e) => {
                          const text = e.target.value.trim()
                          if (category.id === 'derivedFrom') {
                            // What's typed filters the pictures; it's also
                            // stored verbatim, so an original that isn't in
                            // this folder can still be named in words.
                            setDerivedSearch(e.target.value)
                            setPendingTags((prev) => ({ ...prev, [category.id]: text ? [text] : [] }))
                            return
                          }
                          setPendingTags((prev) => ({ ...prev, [category.id]: text ? [text] : [] }))
                        }}
                        placeholder={category.id === 'derivedFrom' ? 'Pick the original…' : `${category.name}…`}
                        className="w-full rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                      />
                      {/* Proof the link points where you meant it to: a hash
                          resolved to a title is still just words, and the
                          original is the one thing that settles it. Opens in
                          the in-app viewer rather than a new tab, which an
                          installed PWA gives no way back from. */}
                      {category.id === 'derivedFrom' &&
                        activeValues[0] &&
                        location &&
                        (() => {
                          const original = originalFor(activeValues[0])
                          if (!original) return null
                          return (
                            <button
                              type="button"
                              onClick={() => setViewingPath(original.path)}
                              className="shrink-0"
                              title={`Open ${original.name}`}
                            >
                              <Thumbnail
                                loc={location}
                                path={original.path}
                                alt={original.name}
                                px={64}
                                className="h-8 w-8 shrink-0 rounded object-cover ring-1 ring-zinc-300 dark:ring-zinc-700"
                              />
                            </button>
                          )
                        })()}
                      </div>
                      {/* The folder's own pictures as suggestions, so linking
                          an original is a choice rather than remembering a
                          filename like 47C020DA-E0C5-468B-9266-529B7E5FABC9.
                          A picture, not a name: for abstract work the filename
                          says nothing about which piece it is, which is the
                          whole reason a list of names was the wrong control.
                          Hand-rolled rather than a datalist because that can
                          only render text. */}
                      {category.id === 'derivedFrom' && derivedSearch !== null && location && (
                        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                          {derivedMatches.length === 0 && (
                            <p className="px-2 py-2 text-xs text-zinc-400">
                              Nothing here by that name — the words are kept as typed.
                            </p>
                          )}
                          {derivedMatches.map((f) => (
                            <button
                              key={f.path}
                              type="button"
                              // Keeps focus in the field so the list survives
                              // long enough for this click to happen.
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setPendingTags((prev) => ({ ...prev, derivedFrom: [f.md5!] }))
                                setDerivedSearch(null)
                              }}
                              className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            >
                              <Thumbnail
                                loc={location}
                                path={f.path}
                                alt={f.name}
                                px={64}
                                className="h-8 w-8 shrink-0 rounded object-cover"
                              />
                              {/* Both, where there are both: the title is
                                  what the artist calls it, the filename is
                                  what she'll recognise from anywhere else. */}
                              <span className="min-w-0 flex-1">
                                {titleFor(f) && (
                                  <span className="block truncate text-xs">{titleFor(f)}</span>
                                )}
                                <span
                                  className={
                                    titleFor(f)
                                      ? 'block truncate text-[11px] text-zinc-500'
                                      : 'block truncate text-xs'
                                  }
                                >
                                  {f.name}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      </>
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
                  </div>
                )
              })}
            </div>

            {/* Everything the file told us, behind one heading. Compact on
                purpose: these are corrected occasionally, not chosen, so a
                current value and a way to change it is the whole job. */}
            {(() => {
              const fromFile = orderedCategories.filter((c) => READ_FROM_FILE_IDS.has(c.id))
              if (fromFile.length === 0) return null
              const setCount = fromFile.filter((c) => (pendingTags[c.id]?.length ?? 0) > 0).length
              return (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                    Read from the file — {setCount} of {fromFile.length} set
                  </summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {fromFile.map((category) => (
                      <div key={category.id} className="flex flex-wrap items-baseline gap-2">
                        <span className="shrink-0 text-xs text-zinc-500 sm:w-20 sm:text-right">{category.name}</span>
                        {(pendingTags[category.id] ?? []).map((value) => (
                          <button
                            key={value}
                            onClick={() => toggleValue(category.id, value)}
                            className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs text-white"
                            title="Remove"
                          >
                            {value} ✕
                          </button>
                        ))}
                        {(pendingTags[category.id]?.length ?? 0) === 0 && (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                        <input
                          value={newValueDrafts[category.id] ?? ''}
                          onChange={(e) => setNewValueDrafts((prev) => ({ ...prev, [category.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addValue(category.id, newValueDrafts[category.id] ?? '')
                            }
                          }}
                          placeholder="add…"
                          className="w-24 rounded border border-zinc-300 px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                        />
                      </div>
                    ))}
                  </div>
                </details>
              )
            })()}
            </div>

            <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
              {saveError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{saveError}</p>}
              <div className="flex justify-end gap-2">
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
        </div>
      )}

      {/* Above the editor, closing back to it rather than out of the app. */}
      {viewingPath && location && (
        <ImageViewer
          loc={location}
          path={viewingPath}
          title={viewingPath.split('/').pop()}
          tags={pendingTags}
          categories={categories}
          onClose={() => setViewingPath(null)}
        />
      )}
    </div>
  )
}
