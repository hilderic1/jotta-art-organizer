import type { Category } from './metadata'

export type CategoryType = 'date' | 'geo' | 'regular'

// Every category holding a date gets the range filter, not just the ones that
// existed when this was written. A date rendered as pills is one value per day
// — hundreds of buttons that filter to a single afternoon each.
const DATE_CATEGORY_IDS = new Set([
  'photoTakenTime',
  'creationTime',
  'year',
  'dateAcquired',
  'jottaCreated',
  'editorCreated',
  'fileChanged',
])
const GEO_CATEGORY_IDS = new Set(['geoData'])

export function getCategoryType(categoryId: string): CategoryType {
  if (DATE_CATEGORY_IDS.has(categoryId)) return 'date'
  if (GEO_CATEGORY_IDS.has(categoryId)) return 'geo'
  return 'regular'
}

export function isHighCardinality(category: Category): boolean {
  const type = getCategoryType(category.id)
  if (type === 'date' || type === 'geo') return true
  // Regular categories: high if > 50 values
  return category.values.length > 50
}

export function parseDateValue(value: string): Date | null {
  // Handle various date formats: YYYY, YYYY-MM-DD, ISO strings, timestamps
  const num = parseInt(value, 10)
  if (!isNaN(num)) {
    if (num > 100000) return new Date(num) // timestamp in ms
    if (num >= 1900 && num <= 2100) return new Date(num, 0, 1) // year only
  }
  const parsed = new Date(value)
  return !isNaN(parsed.getTime()) ? parsed : null
}

export function extractCountryFromGeo(geoValue: string): string {
  // Parse various geo formats: "lat,lng", "Country, Region", etc.
  // For now, assume it might be "Country, Region" or coordinate format
  // If it's coordinates (lat,lng), we'd need reverse geocoding
  // If it's already text, extract the first part as country
  const parts = geoValue.split(',').map((p) => p.trim())
  if (parts.length > 0 && isNaN(parseFloat(parts[0]))) {
    // Looks like text, not coordinates
    return parts[0]
  }
  // For coordinates, would need reverse geocoding API
  // For now, return the raw value
  return geoValue
}
