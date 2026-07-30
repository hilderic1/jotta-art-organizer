'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  getSessionStatus,
  listFolder,
  jottaTime,
  type SessionStatus,
  type MountpointRef,
  type JottaEntry,
} from '@/lib/api'
import { LocationPicker } from '@/components/LocationPicker'
import { Thumbnail } from '@/components/Thumbnail'

type Probe = {
  file: string
  bytesRead: number
  format: string
  exif?: {
    byteOrder: string
    ifd0: { tag: number; name: string; type: number; value?: string }[]
    exifIfd: { tag: number; name: string; type: number; value?: string }[]
  }
  iptc?: { dataset: string; value: string }[]
  c2paStrings?: string[]
  chunks?: { type: string; length: number; keyword?: string }[]
  segments?: { marker: string; length: number; identifier?: string }[]
  error?: string
}

type Sort = 'name' | 'created-desc' | 'created-asc' | 'modified-desc'

function changedAt(file: JottaEntry): number {
  return jottaTime(file.modified) || jottaTime(file.created)
}

function sortFiles(files: JottaEntry[], sort: Sort): JottaEntry[] {
  const sorted = [...files]
  switch (sort) {
    case 'created-desc':
      return sorted.sort((a, b) => jottaTime(b.created) - jottaTime(a.created))
    case 'created-asc':
      return sorted.sort((a, b) => jottaTime(a.created) - jottaTime(b.created))
    // Falls back to arrival: same clock, and a file never touched since upload
    // last changed when it landed.
    case 'modified-desc':
      return sorted.sort((a, b) => changedAt(b) - changedAt(a))
    default:
      return sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
}

// Turns the raw dump into the handful of statements someone actually wants:
// which dates this file carries, what made it, whether AI signed it.
function summarise(probe: Probe): { label: string; value: string }[] {
  const found: { label: string; value: string }[] = []
  const tags = [...(probe.exif?.ifd0 ?? []), ...(probe.exif?.exifIfd ?? [])]
  const tagValue = (name: string) => tags.find((t) => t.name === name)?.value

  const taken = tagValue('DateTimeOriginal')
  if (taken) found.push({ label: 'Date taken', value: taken })

  const changed = tagValue('DateTime')
  if (changed && changed !== taken) found.push({ label: 'Last changed', value: changed })

  const iptcDate = probe.iptc?.find((i) => i.dataset.includes('DateCreated'))?.value
  if (iptcDate && !taken) found.push({ label: 'Date created', value: iptcDate })

  const software = tagValue('Software')
  if (software) found.push({ label: 'Made with', value: software })

  const credit = probe.iptc?.find((i) => i.dataset.includes('Credit'))?.value
  if (credit) found.push({ label: 'Credit', value: credit })

  const manifest = (probe.c2paStrings ?? []).join(' ')
  const sourceType = /digitalsourcetype\/([A-Za-z]+)/.exec(manifest)?.[1]
  if (sourceType) found.push({ label: 'Content credentials', value: sourceType })

  // The editor's own session record, where the only date on older artwork hides.
  const description = tagValue('ImageDescription')
  const session = description ? /_(\d{13})\b/.exec(description)?.[1] : undefined
  if (session) {
    found.push({ label: 'Editing session', value: new Date(Number(session)).toISOString().slice(0, 10) })
  }

  return found
}

export default function InspectPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [location, setLocation] = useState<(MountpointRef & { path?: string }) | null>(null)
  const [files, setFiles] = useState<JottaEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('name')
  const [typedName, setTypedName] = useState('')
  const [selected, setSelected] = useState<JottaEntry | null>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [busy, setBusy] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    getSessionStatus().then(setSession)
  }, [])

  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [])

  useEffect(() => {
    if (!location) return
    let ignore = false
    setFiles(null)
    setSelected(null)
    setProbe(null)
    listFolder(location, location.path ?? '')
      .then((listing) => {
        if (!ignore) {
          setFiles(listing.files.filter((f) => /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name)))
          setListError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setListError(err instanceof Error ? err.message : 'Failed to list that folder.')
      })
    return () => {
      ignore = true
    }
  }, [location])

  async function inspect(file: JottaEntry) {
    if (!location) return
    setSelected(file)
    setProbe(null)
    setShowRaw(false)
    setBusy(true)
    try {
      const params = new URLSearchParams({
        device: location.device,
        mountpoint: location.mountpoint,
        path: file.path,
      })
      const res = await fetch(`/api/files/metadata-probe?${params.toString()}`)
      setProbe(await res.json())
    } catch (err) {
      setProbe({
        file: file.path,
        bytesRead: 0,
        format: 'unknown',
        error: err instanceof Error ? err.message : 'Could not read that file.',
      })
    } finally {
      setBusy(false)
    }
  }

  // Typing a name reaches files the thumbnail grid won't show — anything in a
  // subfolder, or a format we don't list. A value containing a slash is taken
  // as a path from the mountpoint; otherwise it's a name in this folder.
  function inspectTyped() {
    const typed = typedName.trim()
    if (!typed || !location) return
    const path = typed.includes('/') ? typed : [location.path, typed].filter(Boolean).join('/')
    inspect({ name: path.split('/').pop() ?? typed, path, isFolder: false })
  }

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

  const summary = probe && !probe.error ? summarise(probe) : []

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Inspect a file</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Shows what a picture records about itself. Useful when a date or a tag doesn&rsquo;t appear where you
          expected it — this tells you whether the file is missing that information, or whether the app failed to
          read it.
        </p>
      </div>

      {!location && <LocationPicker onSelect={setLocation} />}

      {location && (
        <>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-zinc-600 dark:text-zinc-400">
              🗂 {location.path ? `${location.mountpoint}/${location.path}` : location.mountpoint}
            </span>
            <button
              onClick={() => setLocation(null)}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Change folder
            </button>
          </div>

          <div className="flex gap-2">
            <input
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  inspectTyped()
                }
              }}
              placeholder="Or type a file name, or a path from the mountpoint…"
              className="flex-1 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              onClick={inspectTyped}
              className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Inspect
            </button>
          </div>
        </>
      )}

      {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}
      {location && files === null && !listError && <p className="text-sm text-zinc-500">Loading folder…</p>}
      {files?.length === 0 && <p className="text-sm text-zinc-500">No pictures directly in this folder.</p>}

      {files && files.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="name">Name</option>
              <option value="created-desc">Newest first</option>
              <option value="created-asc">Oldest first</option>
              <option value="modified-desc">Recently changed</option>
            </select>
            <span className="text-zinc-400">{files.length} pictures</span>
          </div>

          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {sortFiles(files, sort).map((f) => (
              <li key={f.path}>
                <button
                  onClick={() => inspect(f)}
                  className="w-full rounded-lg border border-zinc-200 p-1 hover:border-indigo-400 dark:border-zinc-800"
                  title={f.name}
                >
                  <Thumbnail loc={location!} path={f.path} alt={f.name} px={128} className="h-16 w-full rounded object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="text-sm text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer font-medium">Where this information hides</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p>
            A picture can carry its history in several separate compartments, written by different programs at
            different times. They don&rsquo;t know about each other, which is why one file has a date and the next
            one doesn&rsquo;t.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="font-medium">EXIF</span> — the camera standard. Date taken, dimensions, resolution,
              the app that saved the file. Present in most JPEGs, and in PNGs only if the app bothered.
            </li>
            <li>
              <span className="font-medium">IPTC</span> — a press and publishing standard, older than EXIF. Keeps
              its own date, plus a credit line: Google Photos writes &ldquo;Edited with Google AI&rdquo; here.
            </li>
            <li>
              <span className="font-medium">Content credentials (C2PA)</span> — a signed, tamper-evident record of
              how a file was made, including whether AI was involved. Only tools that support the standard write
              it, and it describes the <em>last</em> app to touch the file, not the one that created it.
            </li>
            <li>
              <span className="font-medium">The app&rsquo;s own notes</span> — Picsart tucks a private record into
              the description field: how long you drew, how many brushes, and a session id whose trailing digits
              are the only date some older artwork has.
            </li>
          </ul>
          <p>
            When a picture shows no date anywhere, that is usually the honest answer rather than a failure — some
            apps simply write none.
          </p>
        </div>
      </details>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg bg-white p-4 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="truncate font-medium" title={selected.name}>
                {selected.name}
              </p>
              <button onClick={() => setSelected(null)} className="shrink-0 text-sm text-zinc-500" title="Close (ESC)">
                ✕
              </button>
            </div>

            {location && (
              <Thumbnail
                loc={location}
                path={selected.path}
                alt={selected.name}
                px={512}
                className="mx-auto max-h-40 w-auto rounded object-contain"
              />
            )}

            {busy && <p className="text-sm text-zinc-500">Reading…</p>}
            {probe?.error && <p className="text-sm text-red-600 dark:text-red-400">{probe.error}</p>}

            {probe && !probe.error && (
              <>
                {/* "We can't read this format" and "this file contains nothing"
                    look identical from the outside and mean opposite things —
                    one is our limitation, the other is the file's. */}
                {probe.format === 'unrecognised' ? (
                  <p className="text-sm text-amber-700 dark:text-amber-500">
                    This app can only look inside JPEG and PNG files so far. It can&rsquo;t read a{' '}
                    {selected.name.split('.').pop()?.toUpperCase()} yet, so this says nothing about whether the file
                    holds a date — only that we haven&rsquo;t looked.
                  </p>
                ) : summary.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    This file records nothing about itself beyond its size — no date, no app name, no signature.
                    That isn&rsquo;t a fault in the app: there is genuinely nothing in the file to read, and the day
                    it reached Jottacloud is the only date it will ever have.
                  </p>
                ) : (
                  <dl className="flex flex-col gap-1 text-sm">
                    {summary.map((row) => (
                      <div key={row.label} className="flex gap-2">
                        <dt className="w-36 shrink-0 text-zinc-500">{row.label}</dt>
                        <dd className="break-all">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                <button
                  onClick={() => setShowRaw((v) => !v)}
                  className="w-fit text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {showRaw ? 'Hide raw details' : 'Show raw details'}
                </button>

                {showRaw && (
                  <pre className="max-h-72 overflow-auto rounded bg-zinc-50 p-2 text-[11px] leading-snug dark:bg-zinc-950">
                    {JSON.stringify(probe, null, 2)}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
