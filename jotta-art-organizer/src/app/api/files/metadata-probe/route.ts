import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { fetchFile } from '@/lib/jotta/client'

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
      if (type === 2) report.value = ascii(n, valueField).slice(0, 60)
      if (tag === 34665 && type === 4) exifPointer = u32(valueField)
      tags.push(report)
    }
    return { tags, exifPointer }
  }

  const first = readIfd(u32(tiffStart + 4))
  const sub = first.exifPointer != null ? readIfd(first.exifPointer) : { tags: [] }
  return { byteOrder: little ? 'little-endian' : 'big-endian', ifd0: first.tags, exifIfd: sub.tags }
}

export async function GET(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()
    const q = request.nextUrl.searchParams
    const device = q.get('device')
    const mountpoint = q.get('mountpoint')
    const path = q.get('path')
    if (!device || !mountpoint || !path) {
      return NextResponse.json({ error: 'device, mountpoint and path are required.' }, { status: 400 })
    }

    const res = await fetchFile(accessToken, username, device, mountpoint, path.split('/').filter(Boolean), {
      range: 'bytes=0-524287',
    })
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
