'use client'

import dynamic from 'next/dynamic'
import { Suspense } from 'react'

const MapGeoFilter = dynamic(() => import('./MapGeoFilter').then((mod) => ({ default: mod.MapGeoFilter })), {
  ssr: false,
  loading: () => <div className="h-96 bg-zinc-100 dark:bg-zinc-800 rounded flex items-center justify-center text-sm text-zinc-500">Loading map...</div>,
})

export function GeoFilter({
  categoryId,
  values,
  onSelectionChange,
}: {
  categoryId: string
  values: string[]
  onSelectionChange: (selected: Set<string>) => void
}) {
  return (
    <Suspense fallback={<div className="h-96 bg-zinc-100 dark:bg-zinc-800 rounded flex items-center justify-center text-sm text-zinc-500">Loading map...</div>}>
      <MapGeoFilter categoryId={categoryId} values={values} onSelectionChange={onSelectionChange} />
    </Suspense>
  )
}
