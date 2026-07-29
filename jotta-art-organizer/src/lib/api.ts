export type SessionStatus =
  | { authenticated: false }
  | { authenticated: true; username: string; metadataLocation: MountpointRef | null }

export async function getSessionStatus(): Promise<SessionStatus> {
  const res = await fetch('/api/session')
  return res.json()
}

export async function disconnectSession(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' })
}

export async function setMetadataLocation(loc: MountpointRef): Promise<void> {
  const res = await fetch('/api/metadata/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to set metadata location.')
}

export async function setup(personalLoginToken: string): Promise<{ username: string }> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personalLoginToken }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Setup failed.')
  return data
}

export type MountpointRef = { device: string; mountpoint: string }

// Jottacloud only stores a 30x30 thumbnail and ignores every size parameter
// it documents (measured), so sizes are real pixel widths now: 30 is the
// stored icon, anything larger is rendered from the original server-side.
export const ICON_PX = 30

export function thumbnailUrl(loc: MountpointRef, path: string, px: number = ICON_PX): string {
  const params = new URLSearchParams({
    device: loc.device,
    mountpoint: loc.mountpoint,
    path,
    px: String(px),
  })
  return `/api/files/thumbnail?${params.toString()}`
}

export function viewUrl(loc: MountpointRef, path: string): string {
  const params = new URLSearchParams({ device: loc.device, mountpoint: loc.mountpoint, path })
  return `/api/files/view?${params.toString()}`
}

export async function listMountpoints(): Promise<MountpointRef[]> {
  const res = await fetch('/api/mountpoints')
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list Jottacloud devices.')
  return data.mountpoints
}

export type JottaEntry = {
  name: string
  path: string
  isFolder: boolean
  md5?: string
  size?: number
  state?: string
  deleted?: boolean
  created?: string
  modified?: string
}

// Jottacloud writes timestamps as "2016-01-25-T14:14:14Z" — a stray hyphen
// before the T that Date rejects outright. Returns 0 for anything missing or
// unparseable so sorts put those entries at one end instead of scattering
// them on NaN comparisons.
export function jottaTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value.replace('-T', 'T'))
  return Number.isNaN(parsed) ? 0 : parsed
}
export type JottaFolderListing = {
  name: string
  path: string
  folders: JottaEntry[]
  files: JottaEntry[]
}

export async function listFolder(
  loc: MountpointRef,
  path: string,
  opts?: { includeDeleted?: boolean }
): Promise<JottaFolderListing> {
  const params = new URLSearchParams({ device: loc.device, mountpoint: loc.mountpoint, path })
  if (opts?.includeDeleted) params.set('includeDeleted', 'true')
  const res = await fetch(`/api/folders?${params.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list folder.')
  return data
}

export async function createFolder(loc: MountpointRef, path: string): Promise<JottaFolderListing> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint, path }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to create folder.')
  return data
}

export async function deleteFile(loc: MountpointRef, path: string, retries: number = 3): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint, path }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete file.')
      return
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries) {
        // Exponential backoff: 500ms, 1s, 2s
        const delay = Math.min(500 * Math.pow(2, attempt), 2000)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError || new Error('Failed to delete file after retries.')
}

export async function copyFile(srcLoc: MountpointRef, srcPath: string, destLoc: MountpointRef, destPath: string): Promise<void> {
  const res = await fetch('/api/files/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      srcDevice: srcLoc.device,
      srcMountpoint: srcLoc.mountpoint,
      srcPath,
      destDevice: destLoc.device,
      destMountpoint: destLoc.mountpoint,
      destPath,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to copy file.')
}

export type WalkEntry = { relPath: string; absPath: string; md5: string; size: number }
export type WalkResult = { files: WalkEntry[]; folderRelPaths: string[] }

// Recursively walks a folder tree with bounded concurrency (folder listings
// discovered mid-walk get queued dynamically, so a simple for-loop /
// Promise.all won't do — workers keep pulling from a shared queue until
// nothing is queued AND nothing is still in flight).
export async function walkTree(
  loc: MountpointRef,
  rootPath: string,
  opts?: { concurrency?: number; onFolder?: (relPath: string) => void }
): Promise<WalkResult> {
  const concurrency = opts?.concurrency ?? 4
  const files: WalkEntry[] = []
  const folderRelPaths: string[] = []
  const rootSegs = rootPath.split('/').filter(Boolean)
  const relOf = (fullPath: string) => fullPath.split('/').filter(Boolean).slice(rootSegs.length).join('/')

  const queue: string[] = [rootPath]
  let inFlight = 0
  let error: unknown = null

  async function processOne(folderPath: string) {
    inFlight++
    try {
      const listing = await listFolder(loc, folderPath)
      for (const f of listing.files) {
        if (f.md5) files.push({ relPath: relOf(f.path), absPath: f.path, md5: f.md5, size: f.size ?? 0 })
      }
      for (const sub of listing.folders) {
        const rel = relOf(sub.path)
        folderRelPaths.push(rel)
        opts?.onFolder?.(rel)
        queue.push(sub.path)
      }
    } catch (err) {
      error = error ?? err
    } finally {
      inFlight--
    }
  }

  await new Promise<void>((resolve) => {
    function pump() {
      if (error) {
        resolve()
        return
      }
      while (queue.length > 0 && inFlight < concurrency) {
        const next = queue.shift()
        if (next === undefined) break
        processOne(next).then(pump)
      }
      if (queue.length === 0 && inFlight === 0) resolve()
    }
    pump()
  })

  if (error) throw error
  return { files, folderRelPaths }
}

type AllocateResponse = {
  path: string
  state: string
  uploadId: string
  uploadUrl: string
  bytes: number
  resumePos: number
  accessToken: string
}

async function allocate(loc: MountpointRef, path: string, bytes: number, md5: string): Promise<AllocateResponse> {
  const res = await fetch('/api/upload/allocate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint, path, bytes, md5 }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to allocate upload.')
  return data
}

function xhrUpload(url: string, file: File, accessToken: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Direct upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Direct upload network error (likely CORS).'))
    xhr.send(file)
  })
}

function xhrProxyUpload(
  loc: MountpointRef,
  path: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload/proxy')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else {
        let message = `Upload failed (${xhr.status})`
        try {
          message = JSON.parse(xhr.responseText).error ?? message
        } catch {}
        reject(new Error(message))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed (network error).'))
    const formData = new FormData()
    formData.set('device', loc.device)
    formData.set('mountpoint', loc.mountpoint)
    formData.set('path', path)
    formData.set('file', file)
    xhr.send(formData)
  })
}

export async function uploadFile(
  loc: MountpointRef,
  folderPath: string,
  file: File,
  md5: string,
  onProgress: (pct: number) => void
): Promise<{ deduped: boolean }> {
  const fullPath = `${folderPath}/${file.name}`.replace(/\/+/g, '/')
  const allocation = await allocate(loc, fullPath, file.size, md5)

  if (allocation.state && allocation.state.toUpperCase() !== 'INCOMPLETE') {
    onProgress(100)
    return { deduped: true }
  }

  try {
    await xhrUpload(allocation.uploadUrl, file, allocation.accessToken, onProgress)
  } catch {
    // Jottacloud's upload endpoint may not send CORS headers for browser
    // requests — fall back to routing the bytes through our own backend.
    await xhrProxyUpload(loc, fullPath, file, onProgress)
  }

  return { deduped: false }
}
