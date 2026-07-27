'use client'

import { useState } from 'react'
import { slugify, type Category } from '@/lib/metadata'

export function CategoryManager({
  categories,
  onChange,
}: {
  categories: Category[]
  onChange: (next: Category[]) => void
}) {
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newValueByCategory, setNewValueByCategory] = useState<Record<string, string>>({})

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

  return (
    <div className="flex flex-col gap-4">
      {categories.length === 0 && <p className="text-sm text-zinc-500">No categories yet — add one below.</p>}

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
        </div>
      ))}

      <div className="flex gap-2">
        <input
          className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="New category name (e.g. Style)…"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCategory()}
        />
        <button
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          onClick={addCategory}
        >
          + Add category
        </button>
      </div>
    </div>
  )
}
