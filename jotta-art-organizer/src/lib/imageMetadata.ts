// Reads dimensions/resolution/date directly from a JPEG or PNG file's own
// embedded metadata — for artwork (Picsart exports etc.) that has no Google
// Photos sidecar at all, this is the only source of "when/how big/what
// resolution" available. Only a small byte-range prefix is fetched (headers
// and metadata chunks/segments always precede the actual pixel data), so
// this stays cheap even run across a very large library.
import { viewUrl, jottaTime, type MountpointRef } from '@/lib/api'
import { PHOTO_TAKEN_TIME_CATEGORY_ID, toIsoDate } from '@/lib/googlePhotosMetadata'

export type ArtworkFileMetadata = {
  width?: number
  height?: number
  xResolution?: number
  yResolution?: number
  dateTakenAtEpochSeconds?: number
  dateAcquiredAtEpochSeconds?: number
  /** Jottacloud's own timestamp for the file, not anything embedded in it —
   *  see JOTTA_CREATED_CATEGORY_ID for why the two are kept apart. */
  jottaCreatedAtEpochSeconds?: number
  /** EXIF DateTime: when software last wrote the file. */
  fileChangedAtEpochSeconds?: number
  /** When the editing session happened, recovered from the editor's own id. */
  editorCreatedAtEpochSeconds?: number
  // The rest of what the editor records about how a piece was made. Ground
  // truth about the working process, which nothing else in the file carries.
  editorPhotosAdded?: number
  editorDrawTimeMs?: number
  editorDrawActions?: number
  editorBrushesUsed?: number
  editorLayersUsed?: number
  editorCanvasWidth?: number
  editorCanvasHeight?: number
  /** From C2PA content credentials — a signed claim, not an inference. */
  sourceType?: string
  authors?: string[]
  programName?: string
  copyright?: string
}

export const DIMENSIONS_CATEGORY_ID = 'dimensions'
export const X_RESOLUTION_CATEGORY_ID = 'xResolution'
export const Y_RESOLUTION_CATEGORY_ID = 'yResolution'
// Named after what Windows Explorer's Details > Origin section calls these
// (per user report) rather than their raw EXIF tag names, since that's the
// property inspector people actually compare these tags against.
export const DATE_ACQUIRED_CATEGORY_ID = 'dateAcquired'
// Deliberately its own category rather than folded into Photo Taken Time:
// this is when the file reached Jottacloud, which for anything uploaded in
// bulk is one date across hundreds of works. Presenting that as the date the
// piece was made would be worse than having no date at all.
export const JOTTA_CREATED_CATEGORY_ID = 'jottaCreated'
// Its own tag rather than a stand-in for Photo Taken Time: for an edited
// image this is the export date, and the two say different things.
export const FILE_CHANGED_CATEGORY_ID = 'fileChanged'
// Its own tag, not Photo Taken Time: nothing was photographed, and for this
// library it is the one date that says when the work was actually made.
export const EDITOR_CREATED_CATEGORY_ID = 'editorCreated'
// Whether a piece incorporates photography is something the editor knows for
// certain, unlike the AI classifier, which can only infer it from the surface.
// From C2PA content credentials: a signed statement of what made the file,
// rather than a guess from its appearance. The one thing in an art library
// that reliably separates your own work from a generated image.
export const SOURCE_TYPE_CATEGORY_ID = 'sourceType'
export const SOURCE_TYPE_VALUES = ['Human-made', 'AI-assisted', 'AI-generated', 'Photograph']

// IPTC digital source types, mapped to plain language. Anything unrecognised
// is kept verbatim rather than forced into one of these.
const DIGITAL_SOURCE_TYPES: Record<string, string> = {
  trainedAlgorithmicMedia: 'AI-generated',
  compositeWithTrainedAlgorithmicMedia: 'AI-assisted',
  algorithmicMedia: 'AI-generated',
  digitalCapture: 'Photograph',
  digitalArt: 'Human-made',
  computationalCapture: 'Photograph',
  humanEdits: 'Human-made',
}

export const PHOTO_USED_CATEGORY_ID = 'photoUsed'
export const PHOTO_USED_VALUES = ['Fully drawn', 'Includes photo']
// Banded rather than exact: a per-file millisecond count would be one value
// per artwork, which browses no better than not tagging it at all.
export const DRAW_TIME_CATEGORY_ID = 'drawTime'
export const DRAW_TIME_VALUES = ['Under 1 min', '1–5 min', '5–15 min', '15–60 min', '1–3 hours', 'Over 3 hours']

function drawTimeBand(ms: number): string {
  const minutes = ms / 60000
  if (minutes < 1) return DRAW_TIME_VALUES[0]
  if (minutes < 5) return DRAW_TIME_VALUES[1]
  if (minutes < 15) return DRAW_TIME_VALUES[2]
  if (minutes < 60) return DRAW_TIME_VALUES[3]
  if (minutes < 180) return DRAW_TIME_VALUES[4]
  return DRAW_TIME_VALUES[5]
}
export const AUTHORS_CATEGORY_ID = 'authors'
export const PROGRAM_NAME_CATEGORY_ID = 'programName'
export const COPYRIGHT_CATEGORY_ID = 'copyright'

export function hasImportableFileTags(m: ArtworkFileMetadata): boolean {
  return (
    (m.width != null && m.height != null) ||
    m.xResolution != null ||
    m.yResolution != null ||
    m.dateTakenAtEpochSeconds != null ||
    m.dateAcquiredAtEpochSeconds != null ||
    m.jottaCreatedAtEpochSeconds != null ||
    m.fileChangedAtEpochSeconds != null ||
    m.editorCreatedAtEpochSeconds != null ||
    m.editorPhotosAdded != null ||
    m.editorDrawTimeMs != null ||
    m.sourceType != null ||
    (m.authors != null && m.authors.length > 0) ||
    m.programName != null ||
    m.copyright != null
  )
}

// Reuses the same `photoTakenTime` category the Google Photos path writes
// to — "when was this taken" means one thing regardless of source.
export function deriveTagsFromFileMetadata(
  m: ArtworkFileMetadata,
  existing: Record<string, string[]> = {}
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...existing }
  if (m.width != null && m.height != null) {
    const dims = `${m.width}x${m.height}`
    next[DIMENSIONS_CATEGORY_ID] = [...new Set([...(next[DIMENSIONS_CATEGORY_ID] ?? []), dims])]
  }
  if (m.xResolution != null) {
    next[X_RESOLUTION_CATEGORY_ID] = [...new Set([...(next[X_RESOLUTION_CATEGORY_ID] ?? []), String(m.xResolution)])]
  }
  if (m.yResolution != null) {
    next[Y_RESOLUTION_CATEGORY_ID] = [...new Set([...(next[Y_RESOLUTION_CATEGORY_ID] ?? []), String(m.yResolution)])]
  }
  if (m.dateTakenAtEpochSeconds != null) {
    const iso = toIsoDate(m.dateTakenAtEpochSeconds)
    next[PHOTO_TAKEN_TIME_CATEGORY_ID] = [...new Set([...(next[PHOTO_TAKEN_TIME_CATEGORY_ID] ?? []), iso])]
  }
  if (m.dateAcquiredAtEpochSeconds != null) {
    const iso = toIsoDate(m.dateAcquiredAtEpochSeconds)
    next[DATE_ACQUIRED_CATEGORY_ID] = [...new Set([...(next[DATE_ACQUIRED_CATEGORY_ID] ?? []), iso])]
  }
  // Both overwrite rather than accumulate: each is a single fact about the
  // file, not a list it can gather more of.
  if (m.sourceType) {
    next[SOURCE_TYPE_CATEGORY_ID] = [m.sourceType]
  }
  if (m.editorPhotosAdded != null) {
    next[PHOTO_USED_CATEGORY_ID] = [m.editorPhotosAdded > 0 ? PHOTO_USED_VALUES[1] : PHOTO_USED_VALUES[0]]
  }
  if (m.editorDrawTimeMs != null && m.editorDrawTimeMs > 0) {
    next[DRAW_TIME_CATEGORY_ID] = [drawTimeBand(m.editorDrawTimeMs)]
  }
  if (m.editorCreatedAtEpochSeconds != null) {
    const iso = toIsoDate(m.editorCreatedAtEpochSeconds)
    next[EDITOR_CREATED_CATEGORY_ID] = [...new Set([...(next[EDITOR_CREATED_CATEGORY_ID] ?? []), iso])]
  }
  if (m.fileChangedAtEpochSeconds != null) {
    const iso = toIsoDate(m.fileChangedAtEpochSeconds)
    next[FILE_CHANGED_CATEGORY_ID] = [...new Set([...(next[FILE_CHANGED_CATEGORY_ID] ?? []), iso])]
  }
  if (m.jottaCreatedAtEpochSeconds != null) {
    const iso = toIsoDate(m.jottaCreatedAtEpochSeconds)
    next[JOTTA_CREATED_CATEGORY_ID] = [...new Set([...(next[JOTTA_CREATED_CATEGORY_ID] ?? []), iso])]
  }
  if (m.authors && m.authors.length > 0) {
    next[AUTHORS_CATEGORY_ID] = [...new Set([...(next[AUTHORS_CATEGORY_ID] ?? []), ...m.authors])]
  }
  if (m.programName) {
    next[PROGRAM_NAME_CATEGORY_ID] = [...new Set([...(next[PROGRAM_NAME_CATEGORY_ID] ?? []), m.programName])]
  }
  if (m.copyright) {
    next[COPYRIGHT_CATEGORY_ID] = [...new Set([...(next[COPYRIGHT_CATEGORY_ID] ?? []), m.copyright])]
  }
  return next
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

const HEADER_RANGE_BYTES = 524288 // 512 KiB — comfortably covers PNG's leading chunks or a JPEG's marker segments before scan data in the overwhelming majority of real files.

async function fetchHeaderBytes(loc: MountpointRef, path: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(viewUrl(loc, path), { headers: { Range: `bytes=0-${HEADER_RANGE_BYTES - 1}` } })
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

function latin1(view: DataView, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(view.getUint8(i))
  return s
}

function bytesEqual(view: DataView, start: number, expected: number[]): boolean {
  if (start + expected.length > view.byteLength) return false
  for (let i = 0; i < expected.length; i++) {
    if (view.getUint8(start + i) !== expected[i]) return false
  }
  return true
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(view: DataView): boolean {
  return bytesEqual(view, 0, PNG_SIGNATURE)
}

function indexOfZero(view: DataView, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (view.getUint8(i) === 0) return i
  }
  return -1
}

// Clamped to the buffer: only a prefix of the file is fetched, so a segment
// header can legitimately claim a length that runs past what we hold. Reading
// what's there beats throwing — an exception here would discard every
// property parsed before it.
function utf8(view: DataView, start: number, end: number): string {
  const from = Math.max(0, Math.min(start, view.byteLength))
  const to = Math.max(from, Math.min(end, view.byteLength))
  if (to === from) return ''
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + from, to - from))
}

// Shared by tEXt and iTXt: the same keywords mean the same things in both,
// only the encoding around them differs.
function applyPngTextKeyword(keyword: string, text: string, result: ArtworkFileMetadata): void {
  const key = keyword.toLowerCase()
  if (key === 'creation time') {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) result.dateTakenAtEpochSeconds = Math.round(parsed / 1000)
  } else if (key === 'author' && text) {
    result.authors = splitAuthors(text)
  } else if (key === 'software' && text) {
    result.programName = text
  } else if (key === 'copyright' && text) {
    result.copyright = text
  }
}

function parsePng(view: DataView): ArtworkFileMetadata {
  const result: ArtworkFileMetadata = {}
  let offset = 8
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, false)
    const type = latin1(view, offset + 4, offset + 8)
    const dataStart = offset + 8

    try {
    if (type === 'IHDR' && dataStart + 8 <= view.byteLength) {
      result.width = view.getUint32(dataStart, false)
      result.height = view.getUint32(dataStart + 4, false)
    } else if (type === 'pHYs' && dataStart + 9 <= view.byteLength) {
      const ppuX = view.getUint32(dataStart, false)
      const ppuY = view.getUint32(dataStart + 4, false)
      const unit = view.getUint8(dataStart + 8)
      if (unit === 1) {
        // Pixels-per-meter -> pixels-per-inch.
        result.xResolution = Math.round(ppuX * 0.0254)
        result.yResolution = Math.round(ppuY * 0.0254)
      }
    } else if (type === 'tEXt' && dataStart + length <= view.byteLength) {
      let nulAt = -1
      for (let i = dataStart; i < dataStart + length; i++) {
        if (view.getUint8(i) === 0) {
          nulAt = i
          break
        }
      }
      if (nulAt !== -1) {
        applyPngTextKeyword(latin1(view, dataStart, nulAt), latin1(view, nulAt + 1, dataStart + length), result)
      }
    } else if (type === 'iTXt' && dataStart + length <= view.byteLength) {
      // Same keywords as tEXt, wrapped in UTF-8 and language tags. Editors
      // that write anything non-ASCII reach for this one, so handling only
      // tEXt silently misses their dates.
      const end = dataStart + length
      const keywordEnd = indexOfZero(view, dataStart, end)
      if (keywordEnd !== -1 && keywordEnd + 2 < end) {
        const compressed = view.getUint8(keywordEnd + 1) !== 0
        const languageEnd = indexOfZero(view, keywordEnd + 3, end)
        const translatedEnd = languageEnd === -1 ? -1 : indexOfZero(view, languageEnd + 1, end)
        // Compressed text needs inflate, which isn't worth pulling in for a
        // field this rarely compressed — skipped rather than mis-read.
        if (!compressed && translatedEnd !== -1) {
          applyPngTextKeyword(latin1(view, dataStart, keywordEnd), utf8(view, translatedEnd + 1, end), result)
        }
      }
    } else if (type === 'caBX' && dataStart + length <= view.byteLength) {
      // C2PA content credentials. PicsArt doesn't write these; generators and
      // editors that support the standard do, which is exactly what makes it
      // worth reading — it tells you which files aren't your own work.
      applyC2pa(latin1(view, dataStart, dataStart + length), result)
    } else if (type === 'eXIf' && dataStart + length <= view.byteLength) {
      // A whole EXIF block, byte-for-byte what a JPEG carries in APP1 minus
      // the "Exif\0\0" prefix — so the existing TIFF reader handles it, and
      // PNGs get DateTimeOriginal, Artist and the rest exactly as JPEGs do.
      parseExifTiff(view, dataStart, result)
    } else if (type === 'IDAT' || type === 'IEND') {
      break // metadata chunks always precede IDAT per the PNG spec
    }
    } catch (err) {
      console.warn('[imageMetadata] skipped a malformed PNG chunk', err)
    }

    offset = dataStart + length + 4 // + 4-byte CRC
  }
  return result
}

function isJpegBytes(view: DataView): boolean {
  return bytesEqual(view, 0, [0xff, 0xd8])
}

// PicsArt writes no date tag of any kind — not DateTimeOriginal, DateTime,
// DateTimeDigitized, IPTC or XMP (all four checked against a real export).
// What it does write is a JSON blob of editing statistics into
// ImageDescription, whose "uid" and "source_sid" end in the session's epoch
// milliseconds: "…-9367310E4FE5_1573058098797". That underscore suffix is the
// only record of when the piece was made.
function picsartTimestamp(description: string | undefined): number | undefined {
  if (!description || !description.includes('_')) return undefined
  const match = /_(\d{13})\b/.exec(description)
  if (!match) return undefined
  const ms = Number(match[1])
  // Sanity-bounded: a 13-digit number that isn't a plausible date is more
  // likely a counter that happens to be that long.
  const earliest = Date.UTC(2005, 0, 1)
  const latest = Date.now() + 86400_000
  if (!Number.isFinite(ms) || ms < earliest || ms > latest) return undefined
  return Math.round(ms / 1000)
}

// The same blob records how the piece was worked on. Note that width/height
// here are the editing canvas, which need not match the exported file — a 640
// canvas written out at 2000px means it was upscaled on export.
// C2PA manifests are CBOR inside JUMBF boxes, but the fields worth having are
// stored as plain text strings, so they can be lifted out without decoding
// CBOR. Everything here fails soft: a manifest we can't read leaves the file
// exactly as it was.
function applyC2pa(manifest: string, result: ArtworkFileMetadata): void {
  // Certificate validity dates use UTCTime (260422155105Z) and the timestamp
  // token its own format, so an ISO pattern picks out only the assertions.
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?/
  const created = new RegExp(`c2pa\\.created[\\s\\S]{0,60}?${iso.source}`).exec(manifest) ?? iso.exec(manifest)
  if (created?.[1]) {
    const parsed = Date.parse(`${created[1]}Z`)
    if (!Number.isNaN(parsed) && result.editorCreatedAtEpochSeconds == null) {
      result.editorCreatedAtEpochSeconds = Math.round(parsed / 1000)
    }
  }

  const sourceType = /digitalsourcetype\/([A-Za-z]+)/.exec(manifest)
  if (sourceType?.[1]) result.sourceType = DIGITAL_SOURCE_TYPES[sourceType[1]] ?? sourceType[1]

  // The generator's name sits after a CBOR length byte, hence the short
  // wildcard rather than an exact offset.
  const generator = /claim_generator_info[\s\S]{0,20}?dname.{0,2}?([A-Za-z][A-Za-z0-9 ._-]{3,40})/.exec(manifest)
  if (generator?.[1] && !result.programName) result.programName = generator[1].trim()
}

function applyEditorStats(description: string | undefined, result: ArtworkFileMetadata): void {
  if (!description || !description.trimStart().startsWith('{')) return
  let data: Record<string, unknown>
  try {
    data = JSON.parse(description) as Record<string, unknown>
  } catch {
    return // not the editor's JSON, or truncated — nothing to read
  }
  const num = (key: string): number | undefined => (typeof data[key] === 'number' ? (data[key] as number) : undefined)

  result.editorPhotosAdded = num('photos_added')
  result.editorDrawTimeMs = num('total_draw_time')
  result.editorDrawActions = num('total_draw_actions')
  result.editorBrushesUsed = num('brushes_used')
  result.editorLayersUsed = num('layers_used')
  result.editorCanvasWidth = num('width')
  result.editorCanvasHeight = num('height')
}

function parseExifDateTime(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!m) return undefined
  const [, y, mo, d, h, mi, sec] = m
  const epochMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
  return Number.isFinite(epochMs) ? Math.round(epochMs / 1000) : undefined
}

// Minimal TIFF/IFD reader — just enough to pull the handful of tags that
// show up in Windows Explorer's Details > Origin section: XResolution/
// YResolution/ResolutionUnit, DateTimeOriginal ("Date taken") and
// DateTimeDigitized ("Date acquired") from the Exif sub-IFD, and Artist
// ("Authors"), Software ("Program name") and Copyright from IFD0.
function parseExifTiff(view: DataView, tiffStart: number, result: ArtworkFileMetadata): void {
  if (tiffStart + 8 > view.byteLength) return
  const b0 = view.getUint8(tiffStart)
  const b1 = view.getUint8(tiffStart + 1)
  let little: boolean
  if (b0 === 0x49 && b1 === 0x49) little = true
  else if (b0 === 0x4d && b1 === 0x4d) little = false
  else return

  const u16 = (abs: number) => view.getUint16(abs, little)
  const u32 = (abs: number) => view.getUint32(abs, little)
  if (u16(tiffStart + 2) !== 42) return

  let resolutionUnit = 2 // EXIF default: inches
  let xRes: number | undefined
  let yRes: number | undefined
  let dateTime: string | undefined
  let dateTimeOriginal: string | undefined
  let dateTimeDigitized: string | undefined
  let exifIfdRelOffset: number | undefined

  function readRational(relOffset: number): number | undefined {
    const abs = tiffStart + relOffset
    if (abs + 8 > view.byteLength) return undefined
    const num = u32(abs)
    const den = u32(abs + 4)
    return den === 0 ? undefined : num / den
  }

  // TIFF ASCII values <=4 bytes (incl. the trailing NUL) are stored inline
  // in the entry's value field itself rather than via an offset.
  function readAscii(count: number, valueFieldAbs: number): string | undefined {
    const abs = count <= 4 ? valueFieldAbs : tiffStart + u32(valueFieldAbs)
    if (abs + count > view.byteLength) return undefined
    let s = ''
    for (let i = 0; i < count; i++) {
      const c = view.getUint8(abs + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s || undefined
  }

  function readIfd(
    relOffset: number,
    onEntry: (tag: number, type: number, count: number, valueFieldAbs: number) => void
  ): void {
    if (relOffset <= 0) return
    const ifdAbs = tiffStart + relOffset
    if (ifdAbs + 2 > view.byteLength) return
    const count = u16(ifdAbs)
    for (let i = 0; i < count; i++) {
      const entryAbs = ifdAbs + 2 + i * 12
      if (entryAbs + 12 > view.byteLength) break
      onEntry(u16(entryAbs), u16(entryAbs + 2), u32(entryAbs + 4), entryAbs + 8)
    }
  }

  let imageDescription: string | undefined
  let artist: string | undefined
  let software: string | undefined
  let copyright: string | undefined

  readIfd(u32(tiffStart + 4), (tag, type, count, valueFieldAbs) => {
    if (tag === 282 && type === 5) xRes = readRational(u32(valueFieldAbs))
    else if (tag === 283 && type === 5) yRes = readRational(u32(valueFieldAbs))
    else if (tag === 296 && type === 3) resolutionUnit = u16(valueFieldAbs)
    else if (tag === 306 && type === 2) dateTime = readAscii(count, valueFieldAbs)
    else if (tag === 270 && type === 2) imageDescription = readAscii(count, valueFieldAbs)
    else if (tag === 315 && type === 2) artist = readAscii(count, valueFieldAbs)
    else if (tag === 305 && type === 2) software = readAscii(count, valueFieldAbs)
    else if (tag === 33432 && type === 2) copyright = readAscii(count, valueFieldAbs)
    else if (tag === 34665 && type === 4) exifIfdRelOffset = u32(valueFieldAbs)
  })

  if (exifIfdRelOffset != null) {
    readIfd(exifIfdRelOffset, (tag, type, count, valueFieldAbs) => {
      if (tag === 36867 && type === 2) dateTimeOriginal = readAscii(count, valueFieldAbs)
      else if (tag === 36868 && type === 2) dateTimeDigitized = readAscii(count, valueFieldAbs)
    })
  }

  if (xRes != null) result.xResolution = Math.round(resolutionUnit === 3 ? xRes * 2.54 : xRes)
  if (yRes != null) result.yResolution = Math.round(resolutionUnit === 3 ? yRes * 2.54 : yRes)
  if (artist) result.authors = splitAuthors(artist)
  if (software) result.programName = software
  if (copyright) result.copyright = copyright

  // Kept apart rather than folded together. DateTime is when software last
  // wrote the file, which for an edited image is the export — presenting that
  // as when the picture was taken would be a guess dressed up as a fact.
  // Guarded like every other field here. Assigning unconditionally lets a
  // segment carrying no dates overwrite dates an earlier one already found —
  // which is how a file with a perfectly good date ended up showing none.
  const taken = parseExifDateTime(dateTimeOriginal)
  if (taken != null) result.dateTakenAtEpochSeconds = taken

  const acquired = parseExifDateTime(dateTimeDigitized)
  if (acquired != null) result.dateAcquiredAtEpochSeconds = acquired

  const changed = parseExifDateTime(dateTime)
  if (changed != null) result.fileChangedAtEpochSeconds = changed

  const edited = picsartTimestamp(imageDescription)
  if (edited != null) result.editorCreatedAtEpochSeconds = edited
  applyEditorStats(imageDescription, result)
}

const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00] // "JFIF\0"
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"
// XMP parsing was tried here and removed. It was added on the theory that an
// editor writing no EXIF might still write XMP, and across both a PicsArt PNG
// and a PicsArt JPEG it produced no date at all — while costing two
// regressions: a truncated segment threw and wiped every property parsed
// before it, and its date could be erased by a later EXIF block. EXIF and the
// PNG text chunks cover what these files actually carry.

function parseJpeg(view: DataView): ArtworkFileMetadata {
  const result: ArtworkFileMetadata = {}
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset++ // resync — shouldn't happen in a well-formed file
      continue
    }
    const marker = view.getUint8(offset + 1)
    if (marker === 0xff) {
      offset++ // fill byte between markers
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2 // no length field on these
      continue
    }

    const length = view.getUint16(offset + 2, false) // includes these 2 length bytes
    const segmentStart = offset + 4
    const segmentDataLength = length - 2

    // Guarded per segment, not per file. A whole-file guard meant one bad
    // segment discarded the EXIF that a previous segment had already parsed
    // successfully — which is how a JPEG ended up showing no dates at all
    // while still having them.
    try {
    if (marker === 0xe0 && segmentStart + 12 <= view.byteLength && bytesEqual(view, segmentStart, JFIF_ID)) {
      const units = view.getUint8(segmentStart + 7)
      const xDensity = view.getUint16(segmentStart + 8, false)
      const yDensity = view.getUint16(segmentStart + 10, false)
      if (units === 1) {
        result.xResolution = xDensity
        result.yResolution = yDensity
      } else if (units === 2) {
        result.xResolution = Math.round(xDensity * 2.54)
        result.yResolution = Math.round(yDensity * 2.54)
      }
    } else if (marker === 0xe1 && segmentStart + 6 <= view.byteLength && bytesEqual(view, segmentStart, EXIF_ID)) {
      parseExifTiff(view, segmentStart + 6, result)
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOF0-15 (excluding DHT/JPG/DAC): precision(1) height(2) width(2)
      if (segmentStart + 5 <= view.byteLength) {
        result.height = view.getUint16(segmentStart + 1, false)
        result.width = view.getUint16(segmentStart + 3, false)
      }
      break // found dimensions; SOS/scan data follows, nothing else to read
    } else if (marker === 0xda) {
      break // start of scan — no more marker segments
    }
    } catch (err) {
      console.warn('[imageMetadata] skipped a malformed JPEG segment', err)
    }

    offset = segmentStart + Math.max(segmentDataLength, 0)
  }
  return result
}

export function parseEmbeddedMetadata(bytes: ArrayBuffer): ArtworkFileMetadata {
  try {
    const view = new DataView(bytes)
    if (isPng(view)) return parsePng(view)
    if (isJpegBytes(view)) return parseJpeg(view)
    return {}
  } catch {
    return {}
  }
}

// `jottaCreated` comes from the folder listing rather than the file, since
// it's Jottacloud's own timestamp — passed in by callers that have the entry
// to hand. Artwork exported from an editor frequently carries no embedded
// date whatsoever, and then this is the only one there is.
export async function readArtworkMetadata(
  loc: MountpointRef,
  path: string,
  opts?: { jottaCreated?: string }
): Promise<ArtworkFileMetadata | null> {
  const bytes = await fetchHeaderBytes(loc, path)

  // A malformed or truncated segment must not cost us the properties already
  // parsed out of the file. This blanked every property on JPEGs once
  // already, when an XMP segment declared a length past the fetched prefix.
  let meta: ArtworkFileMetadata = {}
  if (bytes) {
    try {
      meta = parseEmbeddedMetadata(bytes)
    } catch {
      meta = {}
    }
  }

  const created = jottaTime(opts?.jottaCreated)
  if (created > 0) meta.jottaCreatedAtEpochSeconds = Math.round(created / 1000)

  return hasImportableFileTags(meta) ? meta : null
}
