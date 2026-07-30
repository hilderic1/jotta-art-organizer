'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FolderBrowser } from '@/components/FolderBrowser'
import { uploadFile, getSessionStatus, type SessionStatus, type MountpointRef } from '@/lib/api'
import { hashFileMd5 } from '@/lib/md5'

type QueueItem = {
  id: string
  file: File
  progress: number
  status: 'pending' | 'hashing' | 'uploading' | 'done' | 'deduped' | 'error'
  error?: string
  md5?: string
}

type Destination = { loc: MountpointRef; path: string }

export default function ImportPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [destination, setDestination] = useState<Destination | null>(null)
  const [pickingFolder, setPickingFolder] = useState(true)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deduping, setDeduping] = useState(false)
  const [dedupeMessage, setDedupeMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  function addFiles(files: FileList | null) {
    if (!files) return
    const items: QueueItem[] = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .map((file) => ({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        progress: 0,
        status: 'pending',
      }))
    setQueue((q) => [...q, ...items])
  }

  function updateItem(id: string, patch: Partial<QueueItem>) {
    setQueue((q) => q.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  async function startUpload() {
    if (destination === null) return
    setUploading(true)
    for (const item of queue) {
      if (item.status !== 'pending' && item.status !== 'error') continue
      try {
        updateItem(item.id, { status: 'hashing', error: undefined })
        const md5 = item.md5 ?? (await hashFileMd5(item.file))
        updateItem(item.id, { status: 'uploading', md5 })
        const result = await uploadFile(destination.loc, destination.path, item.file, md5, (pct) =>
          updateItem(item.id, { progress: pct })
        )
        updateItem(item.id, { status: result.deduped ? 'deduped' : 'done', progress: 100 })
      } catch (err) {
        updateItem(item.id, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed.' })
      }
    }
    setUploading(false)
  }

  async function removeDuplicates() {
    setDeduping(true)
    setDedupeMessage(null)
    try {
      // Compare against the *whole* queue, not just still-pending items —
      // otherwise a file that's already finished uploading never gets
      // matched against an identical one still waiting.
      const candidates = queue.filter((i) => i.status !== 'hashing' && i.status !== 'uploading')
      const groups = new Map<string, typeof queue>()

      for (const item of candidates) {
        const md5 = item.md5 ?? (await hashFileMd5(item.file))
        if (item.md5 !== md5) updateItem(item.id, { md5 })

        const group = groups.get(md5) ?? []
        group.push({ ...item, md5 })
        groups.set(md5, group)
      }

      const idsToRemove: string[] = []
      for (const group of groups.values()) {
        if (group.length < 2) continue
        // Prefer keeping a copy that's already confirmed in Jottacloud over
        // one that's still just sitting in the queue.
        const keeper = group.find((i) => i.status === 'done' || i.status === 'deduped') ?? group[0]
        for (const item of group) {
          if (item.id !== keeper.id) idsToRemove.push(item.id)
        }
      }

      if (idsToRemove.length > 0) {
        setQueue((q) => q.filter((i) => !idsToRemove.includes(i.id)))
      }
      setDedupeMessage(
        idsToRemove.length > 0
          ? `Removed ${idsToRemove.length} duplicate${idsToRemove.length === 1 ? '' : 's'}.`
          : 'No duplicates found.'
      )
    } finally {
      setDeduping(false)
    }
  }

  const readyToUpload = destination !== null && queue.some((i) => i.status === 'pending' || i.status === 'error')
  const hasDedupeCandidates = queue.filter((i) => i.status !== 'hashing' && i.status !== 'uploading').length > 1

  if (session === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  if (!session.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your Jottacloud account first.</p>
        <Link href="/setup" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Import artwork</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Uploads finished work from this device into your Jottacloud archive. Choose where it should go, pick your
          files, and they&rsquo;re checked against what&rsquo;s already there so you don&rsquo;t end up with second
          copies.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          1. Destination folder
          {destination !== null && ` — ${destination.loc.mountpoint}${destination.path ? `/${destination.path}` : ''}`}
        </h2>
        {pickingFolder ? (
          <FolderBrowser
            onSelect={(loc, path) => {
              setDestination({ loc, path })
              setPickingFolder(false)
            }}
          />
        ) : (
          <button className="text-sm text-indigo-600 underline dark:text-indigo-400" onClick={() => setPickingFolder(true)}>
            Change folder
          </button>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">2. Add images</h2>
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            addFiles(e.dataTransfer.files)
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragOver ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30' : 'border-zinc-300 dark:border-zinc-700'
          }`}
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Drag and drop finished artwork here, or</p>
          <button
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>
      </section>

      {queue.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">3. Upload</h2>
          <ul className="flex flex-col gap-2">
            {queue.map((item) => (
              <li key={item.id} className="rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{item.file.name}</span>
                  <StatusBadge item={item} />
                </div>
                {(item.status === 'uploading' || item.status === 'hashing') && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full bg-indigo-600 transition-all"
                      style={{ width: `${item.status === 'hashing' ? 5 : item.progress}%` }}
                    />
                  </div>
                )}
                {item.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{item.error}</p>}
              </li>
            ))}
          </ul>

          {destination === null && (
            <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
              ⚠ Pick a destination folder above and click &ldquo;Use this folder&rdquo; before uploading &mdash;
              browsing into a folder alone doesn&apos;t select it.
            </p>
          )}
          {dedupeMessage && <p className="mt-3 text-sm text-zinc-500">{dedupeMessage}</p>}
          <div className="mt-4 flex gap-3">
            <button
              disabled={!hasDedupeCandidates || deduping || uploading}
              onClick={removeDuplicates}
              className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {deduping ? 'Checking…' : 'Remove duplicates'}
            </button>
            <button
              disabled={!readyToUpload || uploading}
              onClick={startUpload}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {uploading ? 'Uploading…' : 'Upload all'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

function StatusBadge({ item }: { item: QueueItem }) {
  const label = {
    pending: 'Waiting',
    hashing: 'Checking…',
    uploading: `${item.progress}%`,
    done: 'Uploaded ✓',
    deduped: 'Already in Jottacloud ✓',
    error: 'Failed',
  }[item.status]

  const color = {
    pending: 'text-zinc-500',
    hashing: 'text-zinc-500',
    uploading: 'text-indigo-600 dark:text-indigo-400',
    done: 'text-green-600 dark:text-green-400',
    deduped: 'text-green-600 dark:text-green-400',
    error: 'text-red-600 dark:text-red-400',
  }[item.status]

  return <span className={`shrink-0 text-xs font-medium ${color}`}>{label}</span>
}
