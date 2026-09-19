// Turns the archived photos from a Takeout check into the list the Google
// Photos selector matches against.
//
// Google labels each photo with its capture time in the time zone where it
// was taken — a photo at O'Hare reads "12:58:53 PM" whatever zone you view
// it from — while Takeout stores the same moment in universal time. So each
// record's time is converted to the local time of its own location, found
// from its coordinates. Photos without a location get the zone the person
// says most of those were taken in.
import tzlookup from '@photostructure/tz-lookup'
import type { ArchivedPhoto } from '@/lib/takeoutCheck'

export type SelectorList = { v: 1; keys: string[] }

// One formatter per zone: building them is the slow part, and a library
// mostly lives in a handful of zones.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(zone, f)
  }
  return f
}

/** "20260901T125853" — the same shape the selector reads off Google's labels. */
export function localKey(epochSeconds: number, zone: string): string {
  const parts: Record<string, string> = {}
  for (const p of formatterFor(zone).formatToParts(new Date(epochSeconds * 1000))) parts[p.type] = p.value
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`
}

export function zoneFor(photo: ArchivedPhoto, homeZone: string): { zone: string; located: boolean } {
  if (photo.lat != null && photo.lon != null) {
    try {
      return { zone: tzlookup(photo.lat, photo.lon), located: true }
    } catch {
      // Out-of-range coordinates: fall through to the home zone.
    }
  }
  return { zone: homeZone, located: false }
}

export function buildSelectorList(
  archived: ArchivedPhoto[],
  homeZone: string
): { list: SelectorList; located: number; unlocated: number } {
  const keys: string[] = []
  let located = 0
  for (const photo of archived) {
    const where = zoneFor(photo, homeZone)
    if (where.located) located++
    keys.push(localKey(photo.takenAt, where.zone))
  }
  return { list: { v: 1, keys }, located, unlocated: archived.length - located }
}
