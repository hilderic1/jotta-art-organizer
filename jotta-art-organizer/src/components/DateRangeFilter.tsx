'use client'

import { useState, useMemo } from 'react'
import { parseDateValue } from '@/lib/categoryTypes'

// A characteristic holding only years gets a year picker. Offering it a
// day-month-year calendar asked for precision the values don't have, and
// made "everything from 2019" a matter of guessing which day to type.
function isYearsOnly(categoryId: string, values: string[]): boolean {
  return categoryId === 'year' || (values.length > 0 && values.every((v) => /^\d{4}$/.test(v.trim())))
}

export function DateRangeFilter({
  categoryId,
  values,
  onSelectionChange,
}: {
  categoryId: string
  values: string[]
  onSelectionChange: (selected: Set<string>) => void
}) {
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')
  const yearsOnly = isYearsOnly(categoryId, values)

  const dateRange = useMemo(() => {
    const dates = values
      .map((v) => ({ value: v, date: parseDateValue(v) }))
      .filter((x) => x.date !== null) as { value: string; date: Date }[]
    if (dates.length === 0) return { min: new Date(), max: new Date() }
    dates.sort((a, b) => a.date.getTime() - b.date.getTime())
    return { min: dates[0].date, max: dates[dates.length - 1].date }
  }, [values])

  const years = useMemo(
    () => [...new Set(values.map((v) => v.trim()).filter((v) => /^\d{4}$/.test(v)))].sort(),
    [values]
  )

  // Worked out from the values being set, not read from state. The old
  // handlers reported the selection from *before* the change — state hadn't
  // updated yet — so Find was always one edit behind what the fields showed.
  function selectionFor(from: string, to: string): Set<string> {
    if (!from && !to) return new Set()
    if (yearsOnly) {
      const low = from ? Number(from) : -Infinity
      const high = to ? Number(to) : Infinity
      return new Set(values.filter((v) => Number(v) >= low && Number(v) <= high))
    }
    const low = from ? new Date(from) : dateRange.min
    // To the end of the chosen day, so a range ending on the 14th includes
    // pictures taken during the 14th rather than only at its first instant.
    const high = to ? new Date(`${to}T23:59:59.999`) : dateRange.max
    return new Set(
      values.filter((v) => {
        const date = parseDateValue(v)
        return date !== null && date >= low && date <= high
      })
    )
  }

  const selected = useMemo(
    () => selectionFor(fromDate, toDate),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionFor reads only these
    [fromDate, toDate, values, dateRange, yearsOnly]
  )

  function update(from: string, to: string) {
    setFromDate(from)
    setToDate(to)
    onSelectionChange(selectionFor(from, to))
  }

  const fieldClass =
    'px-2 py-1 text-sm border border-zinc-300 dark:border-zinc-700 rounded dark:bg-zinc-800 dark:text-white'

  return (
    <div className="flex flex-col gap-3 p-3 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">From</label>
          {yearsOnly ? (
            <select value={fromDate} onChange={(e) => update(e.target.value, toDate)} className={fieldClass}>
              <option value="">Any</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="date"
              value={fromDate}
              onChange={(e) => update(e.target.value, toDate)}
              min={dateRange.min.toISOString().split('T')[0]}
              max={dateRange.max.toISOString().split('T')[0]}
              className={fieldClass}
            />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">To</label>
          {yearsOnly ? (
            <select value={toDate} onChange={(e) => update(fromDate, e.target.value)} className={fieldClass}>
              <option value="">Any</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="date"
              value={toDate}
              onChange={(e) => update(fromDate, e.target.value)}
              min={dateRange.min.toISOString().split('T')[0]}
              max={dateRange.max.toISOString().split('T')[0]}
              className={fieldClass}
            />
          )}
        </div>
        <button
          onClick={() => update('', '')}
          className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Clear
        </button>
      </div>
      {selected.size > 0 && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {selected.size} {yearsOnly ? (selected.size === 1 ? 'year' : 'years') : 'dates'} selected
        </p>
      )}
    </div>
  )
}
