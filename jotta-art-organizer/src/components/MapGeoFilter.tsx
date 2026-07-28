'use client'

import { useState, useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface GeoPoint {
  lat: number
  lng: number
  value: string
}

function parseGeoCode(value: string): GeoPoint | null {
  const parts = value.split(',').map((p) => p.trim())
  if (parts.length === 2) {
    const lat = parseFloat(parts[0])
    const lng = parseFloat(parts[1])
    if (!isNaN(lat) && !isNaN(lng)) {
      return { lat, lng, value }
    }
  }
  return null
}

export function MapGeoFilter({
  categoryId,
  values,
  onSelectionChange,
}: {
  categoryId: string
  values: string[]
  onSelectionChange: (selected: Set<string>) => void
}) {
  const [selectedPoints, setSelectedPoints] = useState<Set<string>>(new Set())

  const geoPoints = useMemo(() => {
    return values.map(parseGeoCode).filter((p): p is GeoPoint => p !== null)
  }, [values])

  const bounds = useMemo(() => {
    if (geoPoints.length === 0) return [[0, 0], [0, 0]]
    const lats = geoPoints.map((p) => p.lat)
    const lngs = geoPoints.map((p) => p.lng)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    // Add padding
    const latPad = Math.max((maxLat - minLat) * 0.1, 5)
    const lngPad = Math.max((maxLng - minLng) * 0.1, 5)
    return [
      [minLat - latPad, minLng - lngPad],
      [maxLat + latPad, maxLng + lngPad],
    ]
  }, [geoPoints])

  const togglePoint = (value: string) => {
    const next = new Set(selectedPoints)
    if (next.has(value)) {
      next.delete(value)
    } else {
      next.add(value)
    }
    setSelectedPoints(next)
    onSelectionChange(next)
  }

  const handleClear = () => {
    setSelectedPoints(new Set())
    onSelectionChange(new Set())
  }

  if (geoPoints.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-3 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800">
        <p className="text-xs text-zinc-500">No location data found</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex justify-between items-center">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Click locations to select:</label>
        {selectedPoints.size > 0 && (
          <button onClick={handleClear} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Clear
          </button>
        )}
      </div>

      <div className="h-96 rounded border border-zinc-300 dark:border-zinc-700 overflow-hidden">
        <MapContainer
          bounds={bounds as L.LatLngBoundsExpression}
          style={{ height: '100%', width: '100%' }}
          zoom={4}
          scrollWheelZoom={true}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          {geoPoints.map((point) => {
            const isSelected = selectedPoints.has(point.value)
            return (
              <CircleMarker
                key={point.value}
                center={[point.lat, point.lng]}
                radius={isSelected ? 8 : 5}
                fillColor={isSelected ? '#4f46e5' : '#9ca3af'}
                fillOpacity={0.7}
                stroke={true}
                weight={isSelected ? 2 : 1}
                color={isSelected ? '#4338ca' : '#6b7280'}
                eventHandlers={{ click: () => togglePoint(point.value) }}
              >
                <Popup>{point.value}</Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      </div>

      {selectedPoints.size > 0 && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {selectedPoints.size} location{selectedPoints.size === 1 ? '' : 's'} selected
        </p>
      )}
    </div>
  )
}
