'use client'

import { MapGeoFilter } from './MapGeoFilter'

export function GeoFilter({
  categoryId,
  values,
  onSelectionChange,
}: {
  categoryId: string
  values: string[]
  onSelectionChange: (selected: Set<string>) => void
}) {
  return <MapGeoFilter categoryId={categoryId} values={values} onSelectionChange={onSelectionChange} />
}
