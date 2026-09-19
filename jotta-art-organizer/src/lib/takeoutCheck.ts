// Before deleting from Google Photos: is the export really all here?
//
// A Takeout export carries a JSON record beside every photo it contains,
// including when Google received that photo. That's enough to answer the two
// questions that decide whether deleting is safe:
//
//   1. Did every exported photo actually arrive in Jottacloud? A record with
//      no picture beside it, or a picture whose upload never finished, is a
//      photo that exists only in Google.
//   2. Up to when is the export complete? The latest "received by Google"
//      date among the records is the moment the export was taken. Anything
//      Google received after that was never exported at all.
//
// The second is the one that matters when deleting by date on the website,
// because the website orders by when a photo was *taken*: an old picture
// uploaded last week sits among the old dates, but isn't in this export.
//
// A picture can also be missing from beside its record on purpose: the
// duplicate cleanup removes copies whose identical content is kept elsewhere.
// Jottacloud keeps removed files in its trash, still listed with their
// content hash, so such a record is checked by content: if the removed
// picture's hash belongs to a live file anywhere in the same storage area,
// the photo is safe after all.
import { listFolder, viewUrl, walkTree, type JottaEntry, type MountpointRef } from '@/lib/api'
import { findMetadataSidecar } from '@/lib/googlePhotosMetadata'

export type MissingPhoto = {
  /** The name Google knew it by, from the record. */
  title: string
  folder: string
  takenAt?: number
  uploadedAt?: number
  /** The picture was here once and was removed, but no copy with the same
   *  content could be found — perhaps it's in the trash only, or kept
   *  somewhere this check didn't look. */
  removedHere?: boolean
}

export type IncompletePhoto = { name: string; folder: string; state: string }

export type TakeoutCheckResult = {
  folders: number
  photos: number
  records: number
  /** Records whose picture isn't here — these exist only in Google. */
  missing: MissingPhoto[]
  /** Records whose picture was removed here as a duplicate, with an
   *  identical copy (same content hash) still stored elsewhere. */
  keptElsewhere: number
  /** Pictures whose upload to Jottacloud never finished. */
  incomplete: IncompletePhoto[]
  /** When Google received the newest photo in the export: the cut-off. */
  latestUpload?: number
  earliestTaken?: number
  latestTaken?: number
  /** Records that couldn't be read. Counted, because a check that silently
   *  skipped some would claim more certainty than it has. */
  unreadable: number
  /** Every exported photo confirmed to be safely here — its picture present
   *  and fully uploaded — with what's needed to find it again in Google
   *  Photos: when it was taken, and where, for the time zone. */
  archived: ArchivedPhoto[]
}

export type ArchivedPhoto = { takenAt: number; lat?: number; lon?: number }

type SidecarRecord = { title?: string; takenAt?: number; uploadedAt?: number; lat?: number; lon?: number }

async function readRecord(loc: MountpointRef, file: JottaEntry): Promise<SidecarRecord | null> {
  try {
    const res = await fetch(viewUrl(loc, file.path))
    if (!res.ok) return null
    const data = (await res.json()) as {
      title?: string
      photoTakenTime?: { timestamp?: string }
      creationTime?: { timestamp?: string }
      geoData?: { latitude?: number; longitude?: number }
      geoDataExif?: { latitude?: number; longitude?: number }
    }
    const num = (s: string | undefined) => {
      const n = Number(s)
      return s && Number.isFinite(n) && n > 0 ? n : undefined
    }
    // Takeout writes 0,0 for "no location" rather than leaving it out —
    // which would otherwise put every such photo in the Gulf of Guinea.
    const geo = [data.geoData, data.geoDataExif].find((g) => g && (g.latitude || g.longitude))
    return {
      lat: geo?.latitude,
      lon: geo?.longitude,
      title: data.title,
      takenAt: num(data.photoTakenTime?.timestamp),
      uploadedAt: num(data.creationTime?.timestamp),
    }
  } catch {
    return null
  }
}

// Takeout also writes album-level records ("metadata.json", "print-subscriptions.json")
// that describe folders, not photos — they have no picture to pair with and
// would otherwise all be reported as missing.
function isPhotoRecord(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.json')) return false
  return !/^(metadata|metadati|métadonnées|print-subscriptions|shared_album_comments|user-generated-memory-titles)(\(\d+\))?\.json$/.test(lower)
}

// The naming rules Takeout actually uses, and nothing looser. A record that
// only pairs by resemblance can't be trusted to mean its photo is here.
function exactPair(recordName: string, mediaName: string): boolean {
  const r = recordName.toLowerCase()
  const m = mediaName.toLowerCase()
  if (r === `${m}.supplemental-metadata.json` || r === `${m}.json`) return true
  // The suffix cut short but the photo's name intact:
  // "IMG_1234.JPG.supplemental-metad.json".
  if (r.startsWith(`${m}.`) && r.endsWith('.json')) return true
  // Numbered duplicates: "IMG_1234(1).jpg" ↔ "IMG_1234.jpg(1).supplemental-metadata.json".
  const dup = m.match(/^(.*)\((\d+)\)(\.[^.]+)$/)
  if (dup) {
    const base = `${dup[1]}${dup[3]}(${dup[2]})`
    if (r === `${base}.supplemental-metadata.json` || r === `${base}.json`) return true
  }
  return false
}

// The name Google knew a picture by, from a record's own filename, for when
// the record can't say. Takeout cuts long names short anywhere in the suffix
// ("….jpg.supplemental-me.json"), so any leftover piece of
// ".supplemental-metadata" goes too.
function titleFromRecordName(name: string): string {
  const base = name.replace(/\.json$/i, '')
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const tail = base.slice(dot + 1).toLowerCase()
    if (tail.length > 0 && 'supplemental-metadata'.startsWith(tail)) return base.slice(0, dot)
  }
  return base
}

const LIST_CONCURRENCY = 4
const READ_CONCURRENCY = 8

export type TakeoutStage = 'listing' | 'reading' | 'indexing'

export async function checkTakeout(
  loc: MountpointRef,
  rootPath: string,
  onProgress?: (stage: TakeoutStage, done: number, total: number) => void
): Promise<TakeoutCheckResult> {
  // Folder by folder, keeping each folder's files together: a record is
  // paired with a picture only among its own siblings, which is how Takeout
  // lays them out. Removed files are kept apart: they don't count as here,
  // but their content hash can show a copy survives elsewhere.
  const byFolder = new Map<string, JottaEntry[]>()
  const removedByFolder = new Map<string, JottaEntry[]>()
  const queue = [rootPath]
  let listed = 0

  async function lister() {
    for (;;) {
      const folder = queue.shift()
      if (folder === undefined) return
      const listing = await listFolder(loc, folder, { includeDeleted: true })
      byFolder.set(folder, listing.files.filter((f) => !f.deleted))
      removedByFolder.set(folder, listing.files.filter((f) => f.deleted && f.md5))
      for (const sub of listing.folders) if (!sub.deleted) queue.push(sub.path)
      listed++
      onProgress?.('listing', listed, listed + queue.length)
    }
  }
  // Workers stop when the queue is momentarily empty, so keep starting rounds
  // until a round finds nothing left — subfolders are discovered mid-walk.
  while (queue.length > 0) {
    await Promise.all(Array.from({ length: LIST_CONCURRENCY }, lister))
  }

  let photos = 0
  const incomplete: IncompletePhoto[] = []
  const unpairedRecords: { file: JottaEntry; folder: string }[] = []
  // Records whose picture is here and fully uploaded: the only ones it's
  // safe to delete from Google.
  const safeRecords = new Set<string>()
  const allRecords: JottaEntry[] = []

  for (const [folder, files] of byFolder) {
    const records = files.filter((f) => isPhotoRecord(f.name))
    const media = files.filter((f) => !f.name.toLowerCase().endsWith('.json'))
    allRecords.push(...records)

    const paired = new Set<string>()
    for (const m of media) {
      photos++
      const complete = !m.state || m.state.toUpperCase() === 'COMPLETED'
      // An upload Jottacloud never finished is in the listing but not safely
      // stored — as good as missing for the purpose of deleting the original.
      if (m.state && m.state.toUpperCase() !== 'COMPLETED') {
        incomplete.push({ name: m.name, folder, state: m.state })
      }
      const record = findMetadataSidecar(records, m.name)
      if (record) {
        paired.add(record.path)
        // Only an exact pairing vouches for a photo. The matcher's fuzzy
        // fallback is right for spotting that a record isn't orphaned — an
        // "-edited" copy lands on its original's record — but if the
        // original itself never arrived, the copy would vouch for it.
        if (complete && exactPair(record.name, m.name)) safeRecords.add(record.path)
      }
    }
    for (const r of records) {
      if (!paired.has(r.path)) unpairedRecords.push({ file: r, folder })
    }
  }

  // Every record is read, not only the unpaired ones: the cut-off date is the
  // latest upload across the whole export, and one unread record could be it.
  const recordData = new Map<string, SidecarRecord | null>()
  let cursor = 0
  let read = 0
  async function reader() {
    for (;;) {
      const file = allRecords[cursor++]
      if (!file) return
      recordData.set(file.path, await readRecord(loc, file))
      read++
      onProgress?.('reading', read, allRecords.length)
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, reader))

  let latestUpload: number | undefined
  let earliestTaken: number | undefined
  let latestTaken: number | undefined
  let unreadable = 0
  for (const record of recordData.values()) {
    if (!record) {
      unreadable++
      continue
    }
    if (record.uploadedAt && (!latestUpload || record.uploadedAt > latestUpload)) latestUpload = record.uploadedAt
    if (record.takenAt) {
      if (!earliestTaken || record.takenAt < earliestTaken) earliestTaken = record.takenAt
      if (!latestTaken || record.takenAt > latestTaken) latestTaken = record.takenAt
    }
  }

  const archived: ArchivedPhoto[] = []
  for (const path of safeRecords) {
    const record = recordData.get(path)
    if (record?.takenAt) archived.push({ takenAt: record.takenAt, lat: record.lat, lon: record.lon })
  }

  // A record only counts as missing its picture if the record is genuinely
  // about a photo. Pairing is by name, and Takeout's names are messy, so a
  // record whose title *is* present among its siblings was just a naming
  // mismatch rather than a lost file.
  type Candidate = { file: JottaEntry; folder: string; title: string; removed: JottaEntry[] }
  const candidates: Candidate[] = []
  for (const { file, folder } of unpairedRecords) {
    const record = recordData.get(file.path)
    const title = record?.title ?? titleFromRecordName(file.name)
    const siblings = byFolder.get(folder) ?? []
    // Not reported as missing, but not vouched for either: duplicates share
    // a title, so a present file by that name may be the other one.
    if (siblings.some((s) => s.name.toLowerCase() === title.toLowerCase())) continue
    // The picture that used to sit beside this record, if it was removed.
    const removed = (removedByFolder.get(folder) ?? []).filter(
      (r) => exactPair(file.name, r.name) || r.name.toLowerCase() === title.toLowerCase()
    )
    candidates.push({ file, folder, title, removed })
  }

  // Only when some removed picture needs vouching for: gather the content
  // hashes of every live file in this storage area — the export and
  // everything around it, where the duplicate cleanup kept its copies.
  const liveHashes = new Set<string>()
  if (candidates.some((c) => c.removed.length > 0)) {
    let indexed = 0
    const walk = await walkTree(loc, '', {
      concurrency: LIST_CONCURRENCY,
      onFolder: () => onProgress?.('indexing', ++indexed, 0),
    })
    for (const f of walk.files) liveHashes.add(f.md5)
  }

  const missing: MissingPhoto[] = []
  let keptElsewhere = 0
  for (const { file, folder, title, removed } of candidates) {
    const record = recordData.get(file.path)
    // Same content hash as a live file, and fully stored when it was here:
    // the photo is safe, just not in this folder any more.
    if (removed.some((r) => r.md5 && liveHashes.has(r.md5))) {
      keptElsewhere++
      if (record?.takenAt) archived.push({ takenAt: record.takenAt, lat: record.lat, lon: record.lon })
      continue
    }
    missing.push({
      title,
      folder,
      takenAt: record?.takenAt,
      uploadedAt: record?.uploadedAt,
      removedHere: removed.length > 0 || undefined,
    })
  }

  return {
    archived,
    keptElsewhere,
    folders: byFolder.size,
    photos,
    records: allRecords.length,
    missing,
    incomplete,
    latestUpload,
    earliestTaken,
    latestTaken,
    unreadable,
  }
}
