// Small shared helpers for reading/writing a JSON file stored inside the
// user's Jottacloud account, reusing the same upload/view plumbing as
// everything else in the app (no separate database).
import { createFolder, uploadFile, viewUrl, type MountpointRef } from '@/lib/api'
import { hashFileMd5 } from '@/lib/md5'

export async function readJsonFile<T>(loc: MountpointRef, path: string): Promise<T | null> {
  const res = await fetch(viewUrl(loc, path))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read ${path} (${res.status}).`)
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

export async function writeJsonFile(
  loc: MountpointRef,
  folderPath: string,
  filename: string,
  data: unknown
): Promise<void> {
  try {
    await createFolder(loc, folderPath)
  } catch {
    // Already exists — fine.
  }
  const file = new File([JSON.stringify(data)], filename, { type: 'application/json' })
  const md5 = await hashFileMd5(file)
  await uploadFile(loc, folderPath, file, md5, () => {})
}
