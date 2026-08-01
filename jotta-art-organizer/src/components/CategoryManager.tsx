'use client'

import { useState } from 'react'
import { slugify, type Category } from '@/lib/metadata'
import { getCategoryType, isHighCardinality } from '@/lib/categoryTypes'

// Characteristics whose values the files decide, not you: dates and places
// read out of the pictures, and any vocabulary that has grown past the point
// of being one — a list you'd curate by hand doesn't reach fifty entries.
function readFromFiles(category: Category): boolean {
  return getCategoryType(category.id) !== 'regular' || isHighCardinality(category)
}

// What the collected values are for, which is the part worth saying: they
// look like clutter until you know Find is built out of them.
function keptFor(category: Category): string {
  const type = getCategoryType(category.id)
  if (type === 'date') return 'Find can offer a date range'
  if (type === 'geo') return 'Find can offer places to filter by'
  return 'Find can filter by them'
}

function valueNoun(category: Category): string {
  const type = getCategoryType(category.id)
  const plural = category.values.length !== 1
  if (type === 'date') return plural ? 'dates' : 'date'
  if (type === 'geo') return plural ? 'places' : 'place'
  return plural ? 'values' : 'value'
}

export function CategoryManager({
  categories,
  onChange,
}: {
  categories: Category[]
  onChange: (next: Category[]) => void
}) {
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newValueByCategory, setNewValueByCategory] = useState<Record<string, string>>({})
  // Which collected lists are expanded. Thousands of dates are worth being
  // able to look at once, and worth not rendering the rest of the time.
  const [shownValues, setShownValues] = useState<Set<string>>(new Set())

  function toggleShowValues(categoryId: string) {
    setShownValues((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  function addCategory() {
    const name = newCategoryName.trim()
    if (!name) return
    const id = slugify(name)
    if (!id || categories.some((c) => c.id === id)) return
    onChange([...categories, { id, name, values: [] }])
    setNewCategoryName('')
  }

  function removeCategory(id: string) {
    onChange(categories.filter((c) => c.id !== id))
  }

  function addValue(categoryId: string) {
    const value = (newValueByCategory[categoryId] ?? '').trim()
    if (!value) return
    onChange(
      categories.map((c) => (c.id === categoryId && !c.values.includes(value) ? { ...c, values: [...c.values, value] } : c))
    )
    setNewValueByCategory((prev) => ({ ...prev, [categoryId]: '' }))
  }

  function removeValue(categoryId: string, value: string) {
    onChange(categories.map((c) => (c.id === categoryId ? { ...c, values: c.values.filter((v) => v !== value) } : c)))
  }

  // Turning free text on discards the collected values: they're one-off
  // entries by definition, and keeping them would leave a picker behind for a
  // field that no longer uses one. Tags already on files are untouched.
  function toggleFreeText(categoryId: string, freeText: boolean) {
    onChange(
      categories.map((c) => (c.id === categoryId ? { ...c, freeText, values: freeText ? [] : c.values } : c))
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {categories.length === 0 && <p className="text-sm text-zinc-500">No characteristics yet — add one below.</p>}

      {categories.map((category) => (
        <div key={category.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">{category.name}</h3>
            <button
              className="text-xs text-red-600 hover:underline dark:text-red-400"
              onClick={() => removeCategory(category.id)}
            >
              Remove category
            </button>
          </div>

          {/* Offered only where it's a real choice. On a collected
              characteristic, ticking it would empty the values — and those
              values are what Find's date range and place list are built from,
              so the filter would quietly stop working. */}
          <label
            className={
              readFromFiles(category)
                ? 'mb-2 flex w-fit cursor-not-allowed items-start gap-2 text-xs text-zinc-400'
                : 'mb-2 flex w-fit items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400'
            }
          >
            <input
              type="checkbox"
              checked={category.freeText === true}
              disabled={readFromFiles(category)}
              onChange={(e) => toggleFreeText(category.id, e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Free text
              <span className="block text-zinc-400">
                {readFromFiles(category)
                  ? 'Not available here: this characteristic is read from your files, and Find’s filters are built from the values it collects.'
                  : 'For per-file wording like a title or a note. You type it on each file instead of picking from a list, and it isn’t collected into a vocabulary — every entry would be unique, and Find would fill with filters matching one file each.'}
              </span>
            </span>
          </label>

          {category.freeText ? (
            <p className="text-xs text-zinc-400">Typed per file when assigning tags.</p>
          ) : readFromFiles(category) ? (
            // Collected rather than curated: one value per file, read out of
            // the pictures themselves. Find builds its date range and its
            // list of places from exactly these values, so they're kept — but
            // offering an Add box for a date, or a delete that the next read
            // would undo, only invited pointless work.
            <p className="text-xs text-zinc-500">
              {category.values.length.toLocaleString()} {valueNoun(category)}, read from your files —
              kept so {keptFor(category)}.
              {category.values.length > 0 && (
                <>
                  {' '}
                  <button
                    onClick={() => toggleShowValues(category.id)}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {shownValues.has(category.id) ? 'Hide them' : 'Show them'}
                  </button>
                </>
              )}
              {shownValues.has(category.id) && (
                <span className="mt-2 block max-h-40 overflow-y-auto rounded border border-zinc-200 p-2 text-zinc-500 dark:border-zinc-800">
                  {category.values.join(' · ')}
                </span>
              )}
            </p>
          ) : (
          <>
          <div className="mb-2 flex flex-wrap gap-2">
            {category.values.map((value) => (
              <span
                key={value}
                className="flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-xs dark:bg-zinc-800"
              >
                {value}
                <button
                  className="text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                  onClick={() => removeValue(category.id, value)}
                  aria-label={`Remove ${value}`}
                >
                  ×
                </button>
              </span>
            ))}
            {category.values.length === 0 && <span className="text-xs text-zinc-400">No values yet.</span>}
          </div>

          <div className="flex gap-2">
            <input
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="Add value…"
              value={newValueByCategory[category.id] ?? ''}
              onChange={(e) => setNewValueByCategory((prev) => ({ ...prev, [category.id]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addValue(category.id)}
            />
            <button
              className="text-sm font-medium text-indigo-600 dark:text-indigo-400"
              onClick={() => addValue(category.id)}
            >
              Add
            </button>
          </div>
          </>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <input
          className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="New characteristic (e.g. Style)…"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCategory()}
        />
        <button
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          onClick={addCategory}
        >
          + Add characteristic
        </button>
      </div>
    </div>
  )
}
