import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { fetchFile, listFolder } from '@/lib/jotta/client'

// Temporary diagnostic. Reports what a file actually contains — every JPEG
// segment, every EXIF tag id, every PNG chunk — so "there is no date in this
// file" can be established by reading it rather than inferred from the
// absence of one in the UI. Safe to delete.

const EXIF_TAG_NAMES: Record<number, string> = {
  270: 'ImageDescription',
  271: 'Make',
  272: 'Model',
  282: 'XResolution',
  283: 'YResolution',
  296: 'ResolutionUnit',
  305: 'Software',
  306: 'DateTime',
  315: 'Artist',
  33432: 'Copyright',
  34665: 'ExifIFDPointer',
  36867: 'DateTimeOriginal',
  36868: 'DateTimeDigitized',
  40962: 'PixelXDimension',
  40963: 'PixelYDimension',
}

type TagReport = { tag: number; name: string; type: number; value?: string }

function readExif(view: DataView, tiffStart: number): { byteOrder: string; ifd0: TagReport[]; exifIfd: TagReport[] } {
  const b0 = view.getUint8(tiffStart)
  const little = b0 === 0x49
  const u16 = (o: number) => view.getUint16(o, little)
  const u32 = (o: number) => view.getUint32(o, little)

  function ascii(count: number, valueField: number): string {
    const abs = count <= 4 ? valueField : tiffStart + u32(valueField)
    let s = ''
    for (let i = 0; i < count && abs + i < view.byteLength; i++) {
      const c = view.getUint8(abs + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s
  }

  function readIfd(relOffset: number): { tags: TagReport[]; exifPointer?: number } {
    const start = tiffStart + relOffset
    if (start + 2 > view.byteLength) return { tags: [] }
    const count = u16(start)
    const tags: TagReport[] = []
    let exifPointer: number | undefined
    for (let i = 0; i < count; i++) {
      const entry = start + 2 + i * 12
      if (entry + 12 > view.byteLength) break
      const tag = u16(entry)
      const type = u16(entry + 2)
      const n = u32(entry + 4)
      const valueField = entry + 8
      const report: TagReport = { tag, name: EXIF_TAG_NAMES[tag] ?? `unknown(${tag})`, type }
      if (type === 2) report.value = ascii(n, valueField).slice(0, 1200)
      if (tag === 34665 && type === 4) exifPointer = u32(valueField)
      tags.push(report)
    }
    return { tags, exifPointer }
  }

  const first = readIfd(u32(tiffStart + 4))
  const sub = first.exifPointer != null ? readIfd(first.exifPointer) : { tags: [] }
  return { byteOrder: little ? 'little-endian' : 'big-endian', ifd0: first.tags, exifIfd: sub.tags }
}

const IPTC_NAMES: Record<number, string> = {
  55: 'DateCreated',
  60: 'TimeCreated',
  62: 'DigitalCreationDate',
  63: 'DigitalCreationTime',
  80: 'By-line',
  105: 'Headline',
  110: 'Credit',
  116: 'CopyrightNotice',
  120: 'Caption',
}

// APP13 carries Photoshop image resource blocks; the one numbered 0x0404 is
// the IPTC record, which keeps its own dates entirely separate from EXIF.
function readPhotoshopIptc(view: DataView, start: number, end: number): { dataset: string; value: string }[] {
  const found: { dataset: string; value: string }[] = []
  let offset = start
  while (offset + 12 <= end) {
    // '8BIM'
    if (
      view.getUint8(offset) !== 0x38 ||
      view.getUint8(offset + 1) !== 0x42 ||
      view.getUint8(offset + 2) !== 0x49 ||
      view.getUint8(offset + 3) !== 0x4d
    ) {
      offset++
      continue
    }
    const resourceId = view.getUint16(offset + 4, false)
    let p = offset + 6
    const nameLength = view.getUint8(p)
    p += 1 + nameLength
    if ((nameLength + 1) % 2 !== 0) p += 1 // padded to even
    if (p + 4 > end) break
    const size = view.getUint32(p, false)
    p += 4
    const dataStart = p
    const dataEnd = Math.min(dataStart + size, end)

    if (resourceId === 0x0404) {
      let q = dataStart
      while (q + 5 <= dataEnd) {
        if (view.getUint8(q) !== 0x1c) {
          q++
          continue
        }
        const record = view.getUint8(q + 1)
        const dataset = view.getUint8(q + 2)
        const length = view.getUint16(q + 3, false)
        let value = ''
        for (let i = q + 5; i < Math.min(q + 5 + length, dataEnd); i++) {
          value += String.fromCharCode(view.getUint8(i))
        }
        found.push({
          dataset: `${record}:${dataset} ${IPTC_NAMES[dataset] ?? ''}`.trim(),
          value: value.slice(0, 1200),
        })
        q += 5 + length
      }
    }

    offset = dataEnd + (size % 2 === 1 ? 1 : 0)
  }
  return found
}

export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const q = request.nextUrl.searchParams
    const device = q.get('device')
    const mountpoint = q.get('mountpoint')
    if (!device || !mountpoint) {
      return NextResponse.json({ error: 'device and mountpoint are required.' }, { status: 400 })
    }

    // Either name a file outright, or give a folder and an optional extension
    // and let it pick the first match — saves hunting for a filename.
    let segments = (q.get('path') ?? '').split('/').filter(Boolean)
    if (segments.length === 0) {
      const folder = (q.get('folder') ?? '').split('/').filter(Boolean)
      const ext = (q.get('ext') ?? '').toLowerCase().replace('.', '')
      const listing = await listFolder(accessToken, username, device, mountpoint, folder)
      const match = listing.files.find((f) =>
        ext ? f.name.toLowerCase().endsWith(`.${ext}`) : /\.(jpe?g|png)$/i.test(f.name)
      )
      if (!match) {
        return NextResponse.json({ error: `No ${ext || 'image'} found directly in that folder.` }, { status: 404 })
      }
      segments = match.path.split('/').filter(Boolean)
    }
    const path = segments.join('/')

    let res = await fetchFile(accessToken, username, device, mountpoint, segments, {
      range: 'bytes=0-524287',
    })
    // 416 means the file is shorter than the range asked for; fetch it whole.
    if (res.status === 416) {
      res = await fetchFile(accessToken, username, device, mountpoint, segments)
    }
    if (!res.ok) return NextResponse.json({ error: `Could not read the file (${res.status}).` }, { status: 502 })

    const buffer = await res.arrayBuffer()
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    const report: Record<string, unknown> = { file: path, bytesRead: bytes.byteLength }

    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      report.format = 'PNG'
      const chunks: { type: string; length: number; keyword?: string }[] = []
      let offset = 8
      while (offset + 8 <= view.byteLength && chunks.length < 40) {
        const length = view.getUint32(offset, false)
        let type = ''
        for (let i = 0; i < 4; i++) type += String.fromCharCode(view.getUint8(offset + 4 + i))
        const entry: { type: string; length: number; keyword?: string } = { type, length }
        if ((type === 'tEXt' || type === 'iTXt' || type === 'zTXt') && offset + 8 + length <= view.byteLength) {
          let keyword = ''
          for (let i = offset + 8; i < offset + 8 + Math.min(length, 80); i++) {
            const c = view.getUint8(i)
            if (c === 0) break
            keyword += String.fromCharCode(c)
          }
          entry.keyword = keyword
        }
        chunks.push(entry)

        // A PNG can carry a whole EXIF block in eXIf — same TIFF structure a
        // JPEG keeps in APP1, so the same reader applies.
        if (type === 'eXIf' && offset + 8 + length <= view.byteLength) {
          try {
            report.exif = readExif(view, offset + 8)
          } catch (err) {
            report.exifError = err instanceof Error ? err.message : 'failed'
          }
        }

        // caBX carries a C2PA / JUMBF manifest: CBOR-encoded assertions with
        // readable text mixed in. Rather than decode CBOR on spec, pull the
        // printable runs out so the actual contents can be seen first.
        if (type === 'caBX' && offset + 8 + length <= view.byteLength) {
          const runs: string[] = []
          let current = ''
          for (let i = offset + 8; i < Math.min(offset + 8 + length, view.byteLength); i++) {
            const c = view.getUint8(i)
            if (c >= 32 && c < 127) {
              current += String.fromCharCode(c)
              continue
            }
            if (current.length >= 6) runs.push(current)
            current = ''
            if (runs.length >= 150) break
          }
          if (current.length >= 6 && runs.length < 150) runs.push(current)
          report.c2paStrings = runs.slice(0, 150)
        }

        if (type === 'IDAT' || type === 'IEND') break
        offset += 8 + length + 4
      }
      report.chunks = chunks
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      report.format = 'JPEG'
      const segments: { marker: string; length: number; identifier?: string }[] = []
      let offset = 2
      while (offset + 4 <= view.byteLength && segments.length < 40) {
        if (view.getUint8(offset) !== 0xff) {
          offset++
          continue
        }
        const marker = view.getUint8(offset + 1)
        if (marker === 0xff) {
          offset++
          continue
        }
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        const length = view.getUint16(offset + 2, false)
        const segmentStart = offset + 4
        let identifier = ''
        for (let i = segmentStart; i < Math.min(segmentStart + 32, view.byteLength); i++) {
          const c = view.getUint8(i)
          if (c === 0) break
          identifier += String.fromCharCode(c)
        }
        segments.push({ marker: `0x${marker.toString(16).toUpperCase()}`, length, identifier: identifier.slice(0, 32) })

        if (marker === 0xe1 && identifier.startsWith('Exif')) {
          try {
            report.exif = readExif(view, segmentStart + 6)
          } catch (err) {
            report.exifError = err instanceof Error ? err.message : 'failed'
          }
        }
        // APP11 is where a JPEG keeps C2PA, split across segments if large.
        if (marker === 0xeb && segmentStart + 2 <= view.byteLength) {
          const runs: string[] = []
          let current = ''
          for (let i = segmentStart; i < Math.min(segmentStart + length - 2, view.byteLength); i++) {
            const c = view.getUint8(i)
            if (c >= 32 && c < 127) {
              current += String.fromCharCode(c)
              continue
            }
            if (current.length >= 6) runs.push(current)
            current = ''
            if (runs.length >= 150) break
          }
          if (current.length >= 6 && runs.length < 150) runs.push(current)
          const existing = (report.c2paStrings as string[] | undefined) ?? []
          report.c2paStrings = [...existing, ...runs].slice(0, 150)
        }
        if (marker === 0xed && identifier.startsWith('Photoshop')) {
          try {
            report.iptc = readPhotoshopIptc(view, segmentStart, segmentStart + Math.max(length - 2, 0))
          } catch (err) {
            report.iptcError = err instanceof Error ? err.message : 'failed'
          }
        }
        if (marker === 0xda) break
        offset = segmentStart + Math.max(length - 2, 0)
      }
      report.segments = segments
    } else {
      report.format = 'unrecognised'
    }

    return NextResponse.json(report)
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Probe failed.' }, { status: 502 })
  }
}
