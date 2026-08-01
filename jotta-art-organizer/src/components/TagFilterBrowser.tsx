'use client'

import { useMemo, useState } from 'react'
import type { MountpointRef } from '@/lib/api'
import { Thumbnail } from './Thumbnail'
import { ImageViewer } from './ImageViewer'
import { DateRangeFilter } from './DateRangeFilter'
import { GeoFilter } from './GeoFilter'
import { findTitleCategoryId, titleFromTags, type Category, type ArtworkTags } from '@/lib/metadata'
import { getCategoryType, isHighCardinality } from '@/lib/categoryTypes'
import { PHOTO_TAKEN_TIME_CATEGORY_ID } from '@/lib/googlePhotosMetadata'
import {
  DATE_ACQUIRED_CATEGORY_ID,
  EDITOR_CREATED_CATEGORY_ID,
  JOTTA_CREATED_CATEGORY_ID,
} from '@/lib/imageMetadata'

// The best date a record carries, in order of how much it says: when the
// picture was taken, then when the editor made it, then when it was digitised
// or reached Jottacloud. Untagged dates leave 0, which sorts last.
const DATE_CATEGORY_IDS = [
  PHOTO_TAKEN_TIME_CATEGORY_ID,
  EDITOR_CREATED_CATEGORY_ID,
  DATE_ACQUIRED_CATEGORY_ID,
  JOTTA_CREATED_CATEGORY_ID,
]

function bestDate(artwork: ArtworkTags): number {
  for (const id of DATE_CATEGORY_IDS) {
    const stored = artwork.tags[id]?.[0]
    if (!stored) continue
    const parsed = Date.parse(stored)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

export function TagFilterBrowser({ categories, artworks }: { categories: Category[]; artworks: ArtworkTags[] }) {
  const titleCategoryId = findTitleCategoryId(categories)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'all' | 'any'>('all')
  // The whole record rather than just its location: opening a picture from a
  // tag search is exactly when you want to see what it's tagged with.
  const [viewingImage, setViewingImage] = useState<ArtworkTags | null>(null)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  // Special filters (independent of All/Any logic)
  const [dateFilters, setDateFilters] = useState<Map<string, Set<string>>>(new Map())
  const [geoFilters, setGeoFilters] = useState<Map<string, Set<string>>>(new Map())

  function toggle(categoryId: string, value: string) {
    const key = `${categoryId}:${value}`
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleCategoryExpanded(categoryId: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  function handleDateFilterChange(categoryId: string, newSelection: Set<string>) {
    setDateFilters((prev) => {
      const next = new Map(prev)
      if (newSelection.size === 0) {
        next.delete(categoryId)
      } else {
        next.set(categoryId, newSelection)
      }
      return next
    })
  }

  function handleGeoFilterChange(categoryId: string, newSelection: Set<string>) {
    setGeoFilters((prev) => {
      const next = new Map(prev)
      if (newSelection.size === 0) {
        next.delete(categoryId)
      } else {
        next.set(categoryId, newSelection)
      }
      return next
    })
  }

  const matching = useMemo(() => {
    // Filter by special filters (date, geo) — these are ANDed together
    let filtered = artworks
    for (const [categoryId, values] of dateFilters) {
      if (values.size > 0) {
        filtered = filtered.filter((a) => {
          const artworkValues = a.tags[categoryId] || []
          return artworkValues.some((v) => values.has(v))
        })
      }
    }
    for (const [categoryId, values] of geoFilters) {
      if (values.size > 0) {
        filtered = filtered.filter((a) => {
          const artworkValues = a.tags[categoryId] || []
          return artworkValues.some((v) => values.has(v))
        })
      }
    }

    // Then filter by regular tag selections (All/Any logic)
    if (selected.size === 0) return filtered
    const selectedArr = [...selected]
    return filtered.filter((a) => {
      const artworkKeys = new Set<string>()
      for (const [catId, values] of Object.entries(a.tags)) {
        for (const v of values) artworkKeys.add(`${catId}:${v}`)
      }
      return mode === 'all' ? selectedArr.every((k) => artworkKeys.has(k)) : selectedArr.some((k) => artworkKeys.has(k))
    })
  }, [artworks, selected, mode, dateFilters, geoFilters])

  // Matches came out in whatever order the tag store held them, which is by
  // content hash — no order at all, as far as the artist is concerned. Same
  // rule as Assign tags: titled work first, alphabetically, then the rest
  // newest-first.
  const ordered = useMemo(() => {
    return [...matching].sort((a, b) => {
      const left = titleFromTags(a.tags, titleCategoryId)
      const right = titleFromTags(b.tags, titleCategoryId)
      if (left && right) return left.localeCompare(right, undefined, { numeric: true })
      if (left) return -1
      if (right) return 1
      return bestDate(b) - bestDate(a)
    })
  }, [matching, titleCategoryId])

  return (
    <div className="flex flex-col gap-4">
      {categories.length === 0 && (
        <p className="text-sm text-zinc-500">No categories defined yet — add some in the Categories tab first.</p>
      )}

      <div className="flex flex-col gap-3">
        {categories
          .filter((cat) => cat.values.length > 0)
          .map((category) => {
            const type = getCategoryType(category.id)
            const isHighCard = isHighCardinality(category)
            const isExpanded = expandedCategories.has(category.id)
            const categorySelected = Array.from(selected).filter((k) => k.startsWith(`${category.id}:`))

            return (
            <div key={category.id}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-zinc-500">{category.name}</p>
                {isHighCard && (
                  <button
                    onClick={() => toggleCategoryExpanded(category.id)}
                    className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  >
                    {isExpanded ? '▼' : '▶'} {categorySelected.length > 0 ? `(${categorySelected.length})` : ''}
                  </button>
                )}
              </div>

              {(!isHighCard || isExpanded) && (
                <>
                  {type === 'date' && (
                    <DateRangeFilter
                      categoryId={category.id}
                      values={category.values}
                      onSelectionChange={(selected) => handleDateFilterChange(category.id, selected)}
                    />
                  )}

                  {type === 'geo' && (
                    <GeoFilter
                      categoryId={category.id}
                      values={category.values}
                      onSelectionChange={(selected) => handleGeoFilterChange(category.id, selected)}
                    />
                  )}

                  {type === 'regular' && (
                    <div className="flex flex-wrap gap-2">
                      {category.values.map((value) => {
                        const active = selected.has(`${category.id}:${value}`)
                        return (
                          <button
                            key={value}
                            onClick={() => toggle(category.id, value)}
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
                </>
              )}

              {isHighCard && !isExpanded && (
                <p className="text-xs text-zinc-400">
                  {categorySelected.length === 0
                    ? `Click to expand (${category.values.length} values)`
                    : `Showing ${categorySelected.length} selected`}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-500">Tags matching:</span>
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />
            All selected
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === 'any'} onChange={() => setMode('any')} />
            Any selected
          </label>
          {(dateFilters.size > 0 || geoFilters.size > 0) && (
            <span className="text-xs text-zinc-400 ml-2">+ date/location filters (AND)</span>
          )}
        </div>
      )}

      {selected.size === 0 && dateFilters.size === 0 && geoFilters.size === 0 && (
        <p className="text-sm text-zinc-500">Pick one or more filters above to see matches.</p>
      )}

      {(selected.size > 0 || dateFilters.size > 0 || geoFilters.size > 0) && (
        <>
          <p className="text-sm text-zinc-500">
            {matching.length} match{matching.length === 1 ? '' : 'es'}
          </p>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6">
            {ordered.map((a) => (
              <li key={a.md5}>
                <button onClick={() => setViewingImage(a)}>
                  <Thumbnail
                    loc={{ device: a.device, mountpoint: a.mountpoint }}
                    path={a.path}
                    alt={a.path}
                    px={128}
                    className="h-16 w-16 rounded object-cover cursor-pointer hover:opacity-80"
                  />
                </button>
                {/* What she calls it, if she's called it anything — the
                    filename is the fallback, not the headline. */}
                <p
                  className={
                    titleFromTags(a.tags, titleCategoryId)
                      ? 'mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100'
                      : 'mt-1 truncate text-xs text-zinc-500'
                  }
                  title={a.path.split('/').pop()}
                >
                  {titleFromTags(a.tags, titleCategoryId) ?? a.path.split('/').pop()}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {viewingImage && (
        <ImageViewer
          loc={{ device: viewingImage.device, mountpoint: viewingImage.mountpoint }}
          path={viewingImage.path}
          title={viewingImage.path.split('/').pop()}
          tags={viewingImage.tags}
          categories={categories}
          onClose={() => setViewingImage(null)}
        />
      )}
    </div>
  )
}
