// Matches a photo file to its Google Takeout "supplemental-metadata.json"
// sidecar. Takeout's naming is inconsistent for long filenames (the JSON
// name gets truncated differently than the photo) and for duplicate-numbered
// files (the "(n)" counter moves relative to the extension), so this covers
// the common exact cases and falls back to a fuzzy prefix match.
import { viewUrl, type JottaEntry, type MountpointRef } from '@/lib/api'

export type GooglePhotosMetadata = {
  photoTakenTime?: string
  photoTakenAtEpochSeconds?: number
  creationTime?: string
  creationTimeAtEpochSeconds?: number
  description?: string
  favorited: boolean
  people: string[]
  latitude?: number
  longitude?: number
  altitude?: number
  source?: string
  url?: string
}

// Well-known tag category ids that "Use as tags" / batch import can
// auto-populate from Google Photos metadata — named after the sidecar
// JSON's own field names (per user request) rather than invented labels,
// except `year` and `source`, which have no field of their own (derived
// from `photoTakenTime` and from `googlePhotosOrigin`/`appSource`
// respectively).
export const PEOPLE_CATEGORY_ID = 'people'
export const FAVORITED_CATEGORY_ID = 'favorited'
export const YEAR_CATEGORY_ID = 'year'
export const PHOTO_TAKEN_TIME_CATEGORY_ID = 'photoTakenTime'
export const CREATION_TIME_CATEGORY_ID = 'creationTime'
export const GEO_DATA_CATEGORY_ID = 'geoData'
export const SOURCE_CATEGORY_ID = 'source'

export function toIsoDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function hasImportableTags(m: GooglePhotosMetadata): boolean {
  return (
    m.people.length > 0 ||
    m.favorited ||
    Boolean(m.photoTakenAtEpochSeconds) ||
    Boolean(m.creationTimeAtEpochSeconds) ||
    (m.latitude != null && m.longitude != null) ||
    Boolean(m.source)
  )
}

// Derives the same tag set both the single-photo "Use as tags" button and
// the batch importer apply, merging onto whatever tags a photo already has
// so re-running (or resuming a paused batch) is a safe no-op once nothing
// new is found.
export function deriveTagsFromMetadata(
  m: GooglePhotosMetadata,
  existing: Record<string, string[]> = {}
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...existing }
  if (m.people.length > 0) {
    next[PEOPLE_CATEGORY_ID] = [...new Set([...(next[PEOPLE_CATEGORY_ID] ?? []), ...m.people])]
  }
  if (m.favorited) {
    next[FAVORITED_CATEGORY_ID] = [...new Set([...(next[FAVORITED_CATEGORY_ID] ?? []), 'Yes'])]
  }
  if (m.photoTakenAtEpochSeconds) {
    const year = String(new Date(m.photoTakenAtEpochSeconds * 1000).getUTCFullYear())
    next[YEAR_CATEGORY_ID] = [...new Set([...(next[YEAR_CATEGORY_ID] ?? []), year])]
    const photoTakenTime = toIsoDate(m.photoTakenAtEpochSeconds)
    next[PHOTO_TAKEN_TIME_CATEGORY_ID] = [...new Set([...(next[PHOTO_TAKEN_TIME_CATEGORY_ID] ?? []), photoTakenTime])]
  }
  if (m.creationTimeAtEpochSeconds) {
    const creationTime = toIsoDate(m.creationTimeAtEpochSeconds)
    next[CREATION_TIME_CATEGORY_ID] = [...new Set([...(next[CREATION_TIME_CATEGORY_ID] ?? []), creationTime])]
  }
  if (m.latitude != null && m.longitude != null) {
    const geoData = `${m.latitude.toFixed(4)}, ${m.longitude.toFixed(4)}`
    next[GEO_DATA_CATEGORY_ID] = [...new Set([...(next[GEO_DATA_CATEGORY_ID] ?? []), geoData])]
  }
  if (m.source) {
    next[SOURCE_CATEGORY_ID] = [...new Set([...(next[SOURCE_CATEGORY_ID] ?? []), m.source])]
  }
  return next
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

export function findMetadataSidecar(siblingFiles: JottaEntry[], photoName: string): JottaEntry | null {
  // Case-insensitive throughout: Takeout frequently keeps the photo's
  // original camera-cased extension (e.g. "IMG_1234.JPG") while the sidecar
  // JSON's filename uses a different case for its embedded extension (e.g.
  // "IMG_1234.jpg.supplemental-metadata.json") — an exact-case match would
  // silently miss this very common case.
  const lowerPhotoName = photoName.toLowerCase()

  const exactTarget = `${lowerPhotoName}.supplemental-metadata.json`
  const exact = siblingFiles.find((f) => f.name.toLowerCase() === exactTarget)
  if (exact) return exact

  const legacyTarget = `${lowerPhotoName}.json`
  const legacy = siblingFiles.find((f) => f.name.toLowerCase() === legacyTarget)
  if (legacy) return legacy

  // Duplicate-numbered photos: "IMG_1234(1).jpg" often pairs with
  // "IMG_1234.jpg(1).supplemental-metadata.json" — the counter moves after
  // the extension rather than staying with the base name.
  const dupMatch = lowerPhotoName.match(/^(.*)\((\d+)\)(\.[^.]+)$/)
  if (dupMatch) {
    const [, base, counter, ext] = dupMatch
    const candidateTarget = `${base}${ext}(${counter}).supplemental-metadata.json`
    const found = siblingFiles.find((f) => f.name.toLowerCase() === candidateTarget)
    if (found) return found
  }

  // Fuzzy fallback for truncated JSON filenames: prefer the .json file that
  // shares the longest prefix with the photo's name.
  const jsonCandidates = siblingFiles.filter((f) => f.name.toLowerCase().endsWith('.json'))
  let best: JottaEntry | null = null
  let bestScore = 0
  for (const candidate of jsonCandidates) {
    const shared = sharedPrefixLength(lowerPhotoName, candidate.name.toLowerCase())
    if (shared > bestScore && shared >= Math.min(8, lowerPhotoName.length)) {
      bestScore = shared
      best = candidate
    }
  }
  return best
}

// Google Photos records where a file came from in a couple of different
// shapes depending on how it was added — this covers the common ones
// (mobile app upload with a named device folder, or a known app's Android
// package) and simply omits a source rather than guessing at unknown shapes.
function deriveSource(data: {
  googlePhotosOrigin?: {
    mobileUpload?: { deviceFolder?: { localFolderName?: string } }
  }
  appSource?: { androidPackageName?: string }
}): string | undefined {
  const folderName = data.googlePhotosOrigin?.mobileUpload?.deviceFolder?.localFolderName
  if (folderName) return folderName

  const pkg = data.appSource?.androidPackageName
  if (pkg) {
    const short = pkg.split('.').filter(Boolean).pop() ?? pkg
    return short.charAt(0).toUpperCase() + short.slice(1)
  }

  return undefined
}

export async function loadMetadataSidecar(
  loc: MountpointRef,
  sidecar: JottaEntry
): Promise<GooglePhotosMetadata | null> {
  try {
    const res = await fetch(viewUrl(loc, sidecar.path))
    if (!res.ok) return null
    const data = (await res.json()) as {
      photoTakenTime?: { formatted?: string; timestamp?: string }
      creationTime?: { formatted?: string; timestamp?: string }
      description?: string
      favorited?: boolean
      people?: { name?: string }[]
      geoData?: { latitude?: number; longitude?: number; altitude?: number }
      geoDataExif?: { latitude?: number; longitude?: number; altitude?: number }
      url?: string
      googlePhotosOrigin?: { mobileUpload?: { deviceFolder?: { localFolderName?: string } } }
      appSource?: { androidPackageName?: string }
    }
    const lat = data.geoData?.latitude || data.geoDataExif?.latitude
    const lng = data.geoData?.longitude || data.geoDataExif?.longitude
    const alt = data.geoData?.altitude || data.geoDataExif?.altitude
    const timestamp = data.photoTakenTime?.timestamp ? Number(data.photoTakenTime.timestamp) : undefined
    const creationTimestamp = data.creationTime?.timestamp ? Number(data.creationTime.timestamp) : undefined
    return {
      photoTakenTime: data.photoTakenTime?.formatted,
      photoTakenAtEpochSeconds: Number.isFinite(timestamp) ? timestamp : undefined,
      creationTime: data.creationTime?.formatted,
      creationTimeAtEpochSeconds: Number.isFinite(creationTimestamp) ? creationTimestamp : undefined,
      description: data.description || undefined,
      favorited: Boolean(data.favorited),
      people: (data.people ?? []).map((p) => p.name).filter((n): n is string => Boolean(n)),
      latitude: lat || undefined,
      longitude: lng || undefined,
      altitude: alt || undefined,
      source: deriveSource(data),
      url: data.url || undefined,
    }
  } catch {
    return null
  }
}
