'use client'

import { useState, useMemo } from 'react'
import { parseDateValue } from '@/lib/categoryTypes'

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

  const dateRange = useMemo(() => {
    const dates = values
      .map((v) => ({ value: v, date: parseDateValue(v) }))
      .filter((x) => x.date !== null) as { value: string; date: Date }[]
    if (dates.length === 0) return { min: new Date(), max: new Date() }
    dates.sort((a, b) => a.date.getTime() - b.date.getTime())
    return { min: dates[0].date, max: dates[dates.length - 1].date }
  }, [values])

  const selected = useMemo(() => {
    if (!fromDate && !toDate) return new Set<string>()
    const from = fromDate ? new Date(fromDate) : dateRange.min
    const to = toDate ? new Date(toDate) : dateRange.max
    return new Set(
      values.filter((v) => {
        const date = parseDateValue(v)
        return date && date >= from && date <= to
      })
    )
  }, [fromDate, toDate, values, dateRange])

  const handleFromChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFromDate(e.target.value)
    onSelectionChange(selected)
  }

  const handleToChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToDate(e.target.value)
    onSelectionChange(selected)
  }

  const handleClear = () => {
    setFromDate('')
    setToDate('')
    onSelectionChange(new Set())
  }

  return (
    <div className="flex flex-col gap-3 p-3 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={handleFromChange}
            min={dateRange.min.toISOString().split('T')[0]}
            max={dateRange.max.toISOString().split('T')[0]}
            className="px-2 py-1 text-sm border border-zinc-300 dark:border-zinc-700 rounded dark:bg-zinc-800 dark:text-white"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">To</label>
          <input
            type="date"
            value={toDate}
            onChange={handleToChange}
            min={dateRange.min.toISOString().split('T')[0]}
            max={dateRange.max.toISOString().split('T')[0]}
            className="px-2 py-1 text-sm border border-zinc-300 dark:border-zinc-700 rounded dark:bg-zinc-800 dark:text-white"
          />
        </div>
        <button
          onClick={handleClear}
          className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Clear
        </button>
      </div>
      {selected.size > 0 && <p className="text-xs text-zinc-600 dark:text-zinc-400">{selected.size} dates selected</p>}
    </div>
  )
}
