'use client'

import { useState, useMemo } from 'react'
import { extractCountryFromGeo } from '@/lib/categoryTypes'

export function GeoFilter({
  categoryId,
  values,
  onSelectionChange,
}: {
  categoryId: string
  values: string[]
  onSelectionChange: (selected: Set<string>) => void
}) {
  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(new Set())

  const countries = useMemo(() => {
    const countriesList = new Set<string>()
    for (const value of values) {
      const country = extractCountryFromGeo(value)
      if (country && country.length > 0) {
        countriesList.add(country)
      }
    }
    return Array.from(countriesList).sort()
  }, [values])

  const matching = useMemo(() => {
    if (selectedCountries.size === 0) return new Set<string>()
    return new Set(
      values.filter((v) => {
        const country = extractCountryFromGeo(v)
        return selectedCountries.has(country)
      })
    )
  }, [values, selectedCountries])

  const toggleCountry = (country: string) => {
    const next = new Set(selectedCountries)
    if (next.has(country)) {
      next.delete(country)
    } else {
      next.add(country)
    }
    setSelectedCountries(next)
    onSelectionChange(new Set(values.filter((v) => selectedCountries.has(extractCountryFromGeo(v)))))
  }

  const handleClear = () => {
    setSelectedCountries(new Set())
    onSelectionChange(new Set())
  }

  return (
    <div className="flex flex-col gap-3 p-3 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex justify-between items-center">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Select countries/regions:</label>
        {selectedCountries.size > 0 && (
          <button onClick={handleClear} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
        {countries.length === 0 ? (
          <p className="text-xs text-zinc-500">No location data found</p>
        ) : (
          countries.map((country) => {
            const active = selectedCountries.has(country)
            return (
              <button
                key={country}
                onClick={() => toggleCountry(country)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600'
                }`}
              >
                {country}
              </button>
            )
          })
        )}
      </div>
      {selectedCountries.size > 0 && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {selectedCountries.size} region{selectedCountries.size === 1 ? '' : 's'} selected ({matching.size} geo-codes)
        </p>
      )}
    </div>
  )
}
