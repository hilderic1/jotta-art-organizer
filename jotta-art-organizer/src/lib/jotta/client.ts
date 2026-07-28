import { XMLParser } from 'fast-xml-parser'

const JFS_BASE = 'https://jfs.jottacloud.com/jfs'
const ALLOCATE_URL = 'https://api.jottacloud.com/files/v1/allocate'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'folder' || name === 'file' || name === 'device' || name === 'mountPoint',
})

// Elements like <name xml:space="preserve">Archive</name> parse to
// { '@_xml:space': 'preserve', '#text': 'Archive' } instead of a plain
// string once they carry an attribute.
function textOf(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'])
  }
  return ''
}

function encodeSegments(segments: string[]): string {
  return segments
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function jfsUrl(username: string, device: string, mountpoint: string, path: string[] = []): string {
  return `${JFS_BASE}/${encodeSegments([username, device, mountpoint, ...path])}`
}

async function jfsFetch(url: string, accessToken: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/xml',
      ...(init?.headers ?? {}),
    },
  })
  return res
}

export type JottaEntry = {
  name: string
  path: string
  isFolder: boolean
  md5?: string
  size?: number
  state?: string
  deleted?: boolean
}

export type JottaFolderListing = {
  name: string
  path: string
  folders: JottaEntry[]
  files: JottaEntry[]
}

// `requestPath` (the segments we asked for) is used to build each child's
// `path`, rather than the XML's own <path>/<abspath> — those are reported
// relative to the *device*, not the mountpoint, so trusting them produces
// paths that skip the mountpoint segment (e.g. "/user/Jotta/Foo" instead of
// "/user/Jotta/Archive/Foo").
function parseFolderXml(xml: string, requestPath: string[], opts?: { includeDeleted?: boolean }): JottaFolderListing {
  const doc = xmlParser.parse(xml)
  // "folder" and "mountPoint" are both in `isArray` (needed for their
  // *children* — <folders><folder/></folders> — since a single subfolder
  // shouldn't collapse out of the list), so the root element of this
  // response gets 1-item-array-wrapped too, whichever tag it is.
  const rawRoot = doc.folder ?? doc.mountPoint
  const folder = Array.isArray(rawRoot) ? rawRoot[0] : rawRoot
  if (!folder) {
    console.error('[jotta] Unrecognized folder XML, raw response follows:\n', xml)
    console.error('[jotta] Parsed keys at root:', Object.keys(doc))
    throw new Error('Unexpected Jottacloud response: no <folder> or <mountPoint> element found.')
  }
  const name = textOf(folder.name) || requestPath[requestPath.length - 1] || ''
  const path = requestPath.join('/')

  const rawFolders = folder.folders?.folder ?? []
  const rawFiles = folder.files?.file ?? []

  // Jottacloud keeps deleted folders/files in the listing with a
  // `deleted="<timestamp>"` attribute rather than removing them outright —
  // their own app filters these out client-side, and so do we by default.
  // `includeDeleted` keeps them (flagged via `deleted: true`) for the rare
  // case a caller needs to see recently soft-deleted entries too (e.g.
  // recovering tag metadata whose sidecar match only exists under a name
  // that was later deleted as a duplicate).
  const folders: JottaEntry[] = (Array.isArray(rawFolders) ? rawFolders : [rawFolders])
    .filter((f) => f && f['@_name'] && (!f['@_deleted'] || opts?.includeDeleted))
    .map((f) => ({
      name: f['@_name'] ?? '',
      path: [...requestPath, f['@_name'] ?? ''].join('/'),
      isFolder: true,
      deleted: Boolean(f['@_deleted']),
    }))

  const files: JottaEntry[] = (Array.isArray(rawFiles) ? rawFiles : [rawFiles])
    .filter((f) => f && f['@_name'] && (!f['@_deleted'] || opts?.includeDeleted))
    .map((f) => {
      const rev = f.currentRevision
      return {
        name: f['@_name'] ?? '',
        path: [...requestPath, f['@_name'] ?? ''].join('/'),
        isFolder: false,
        md5: rev?.md5,
        size: rev?.size != null ? Number(rev.size) : undefined,
        state: rev?.state,
        deleted: Boolean(f['@_deleted']),
      }
    })

  return { name, path, folders, files }
}

export type MountpointRef = {
  device: string
  mountpoint: string
}

// Lists every device/mountpoint pair on the account (e.g. a phone's
// "Archive", a desktop's "Sync"/"Backup") so the user can pick where to
// browse/upload, rather than us guessing a single default.
export async function listMountpoints(accessToken: string, username: string): Promise<MountpointRef[]> {
  const res = await jfsFetch(`${JFS_BASE}/${encodeURIComponent(username)}`, accessToken)
  if (!res.ok) {
    throw new Error(`Failed to list Jottacloud devices (${res.status}).`)
  }

  const xml = await res.text()
  const doc = xmlParser.parse(xml)
  const user = doc.user
  if (!user) {
    console.error('[jotta] Unrecognized account XML, raw response follows:\n', xml)
    console.error('[jotta] Parsed keys at root:', Object.keys(doc))
    throw new Error('Unexpected Jottacloud response: no <user> element found.')
  }

  const rawDevices = user.devices?.device ?? []
  const devices = Array.isArray(rawDevices) ? rawDevices : [rawDevices]

  const result: MountpointRef[] = []
  for (const d of devices) {
    const deviceName = d?.['@_name'] ?? textOf(d?.name)
    if (!deviceName) continue

    // The account-root listing only names devices — each device's own
    // mountpoints require a separate request one level down.
    const devRes = await jfsFetch(`${JFS_BASE}/${encodeSegments([username, deviceName])}`, accessToken)
    if (!devRes.ok) continue
    const devXml = await devRes.text()
    const devDoc = xmlParser.parse(devXml)
    // `isArray` matches "device" wherever it appears (needed for the
    // <devices><device/><device/></devices> list above), so this endpoint's
    // single root <device> element gets wrapped in a 1-item array too.
    const rawDevice = devDoc.device
    const device = Array.isArray(rawDevice) ? rawDevice[0] : rawDevice
    if (!device) {
      console.error(`[jotta] Unrecognized device XML for "${deviceName}", raw response follows:\n`, devXml)
      continue
    }

    const rawMounts = device.mountPoints?.mountPoint ?? []
    const mounts = Array.isArray(rawMounts) ? rawMounts : [rawMounts]
    for (const m of mounts) {
      const mountName = m?.['@_name'] ?? textOf(m?.name)
      if (mountName) result.push({ device: deviceName, mountpoint: mountName })
    }
  }

  if (result.length === 0) {
    console.error('[jotta] No mountpoints parsed for any device, raw account XML follows:\n', xml)
  }

  return result
}

export async function listFolder(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  path: string[] = [],
  opts?: { includeDeleted?: boolean }
): Promise<JottaFolderListing> {
  const url = jfsUrl(username, device, mountpoint, path)
  const res = await jfsFetch(url, accessToken)
  if (!res.ok) {
    throw new Error(`Failed to list Jottacloud folder "${path.join('/')}" (${res.status}).`)
  }
  const xml = await res.text()
  return parseFolderXml(xml, path, opts)
}

export async function createFolder(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  path: string[]
): Promise<JottaFolderListing> {
  const url = `${jfsUrl(username, device, mountpoint, path)}?mkDir=true`
  const res = await jfsFetch(url, accessToken, { method: 'POST' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to create Jottacloud folder "${path.join('/')}" (${res.status}): ${text.slice(0, 300)}`)
  }
  const xml = await res.text()
  return parseFolderXml(xml, path)
}

// Thumbnail sizes Jottacloud supports: WS (small) .. WXL (extra large).
export type ThumbnailSize = 'WS' | 'WM' | 'WL' | 'WXL'

export async function fetchThumbnail(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  path: string[],
  size: ThumbnailSize = 'WS'
): Promise<Response> {
  const url = `${jfsUrl(username, device, mountpoint, path)}?mode=thumb&width=512&height=512`
  console.log('[Jottacloud API] Thumbnail request:', url)
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
}

// A plain GET on a file's JFS path returns its *metadata* XML (the same
// <file> element shape seen in folder listings), not its bytes — need
// ?mode=bin to get the actual content. `range` (e.g. "bytes=0-524287") is
// forwarded as-is when a caller only needs a byte prefix (e.g. reading
// embedded image metadata without downloading the whole file) — harmless to
// omit, and harmless if Jottacloud ignores it and returns the full file.
export async function fetchFile(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  path: string[],
  opts?: { range?: string }
): Promise<Response> {
  const url = `${jfsUrl(username, device, mountpoint, path)}?mode=bin`
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
  if (opts?.range) headers.Range = opts.range
  return fetch(url, { headers })
}

// Soft-delete only (moves to Jottacloud's trash, recoverable) — this app
// never exposes the permanent "rm=true" variant.
export async function deleteFile(
  accessToken: string,
  username: string,
  device: string,
  mountpoint: string,
  path: string[]
): Promise<void> {
  const url = `${jfsUrl(username, device, mountpoint, path)}?dl=true`
  const res = await jfsFetch(url, accessToken, { method: 'POST' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to delete Jottacloud file "${path.join('/')}" (${res.status}): ${text.slice(0, 300)}`)
  }
}

// Server-side copy — Jottacloud duplicates the file directly on their end,
// no bytes pass through us. `destPath` is sent as a raw (not pre-encoded)
// query parameter value; URLSearchParams handles the single necessary
// encoding pass. Source and destination can be different devices/mountpoints
// (e.g. copying from Archive into a Sync location on another device).
export async function copyFile(
  accessToken: string,
  username: string,
  srcDevice: string,
  srcMountpoint: string,
  srcPath: string[],
  destDevice: string,
  destMountpoint: string,
  destPath: string[]
): Promise<void> {
  const srcUrl = jfsUrl(username, srcDevice, srcMountpoint, srcPath)
  const destRaw = ['', username, destDevice, destMountpoint, ...destPath].join('/')
  const params = new URLSearchParams({ cp: destRaw })

  const res = await jfsFetch(`${srcUrl}?${params.toString()}`, accessToken, { method: 'POST' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Failed to copy "${srcPath.join('/')}" to "${destPath.join('/')}" (${res.status}): ${text.slice(0, 300)}`
    )
  }
}

export type AllocateResult = {
  path: string
  state: string
  uploadId: string
  uploadUrl: string
  bytes: number
  resumePos: number
}

export async function allocateUpload(
  accessToken: string,
  device: string,
  mountpoint: string,
  path: string[],
  bytes: number,
  md5: string,
  created: Date,
  modified: Date
): Promise<AllocateResult> {
  // Unlike the JFS list/create endpoints, /files/v1/allocate lives under a
  // different API (api.jottacloud.com) with its own path scheme: no
  // username (the bearer token already scopes to the account), prefixed
  // with "/jfs", and sent as a raw JSON string rather than URL-encoded.
  const jfsPath = ['', 'jfs', device, mountpoint, ...path].join('/')

  const res = await fetch(ALLOCATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: jfsPath,
      bytes,
      md5,
      created: created.toISOString(),
      modified: modified.toISOString(),
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to allocate Jottacloud upload (${res.status}): ${text.slice(0, 500)}`)
  }

  const data = (await res.json()) as {
    path: string
    state: string
    upload_id: string
    upload_url: string
    bytes: number
    resume_pos: number
  }

  return {
    path: data.path,
    state: data.state,
    uploadId: data.upload_id,
    uploadUrl: data.upload_url,
    bytes: data.bytes,
    resumePos: data.resume_pos,
  }
}
