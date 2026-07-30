'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, listFolder, type SessionStatus, type MountpointRef, type JottaEntry } from '@/lib/api'
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
  const [selected, setSelected] = useState<JottaEntry | null>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [busy, setBusy] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    getSessionStatus().then(setSession)
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
      )}

      {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}
      {location && files === null && !listError && <p className="text-sm text-zinc-500">Loading folder…</p>}
      {files?.length === 0 && <p className="text-sm text-zinc-500">No pictures directly in this folder.</p>}

      {files && files.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => inspect(f)}
                className={`w-full rounded-lg border p-1 ${
                  selected?.path === f.path
                    ? 'border-indigo-500'
                    : 'border-zinc-200 hover:border-indigo-400 dark:border-zinc-800'
                }`}
                title={f.name}
              >
                <Thumbnail loc={location!} path={f.path} alt={f.name} px={128} className="h-16 w-full rounded object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {busy && <p className="text-sm text-zinc-500">Reading {selected?.name}…</p>}

      {probe?.error && <p className="text-sm text-red-600 dark:text-red-400">{probe.error}</p>}

      {probe && !probe.error && (
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="truncate text-sm font-medium">{selected?.name}</p>

          {summary.length === 0 ? (
            <p className="text-sm text-zinc-500">
              This file records nothing about itself beyond its size — no date, no app name, no signature. That
              isn&rsquo;t a fault in the app: there is genuinely nothing in the file to read, and the day it reached
              Jottacloud is the only date it will ever have.
            </p>
          ) : (
            <dl className="flex flex-col gap-1 text-sm">
              {summary.map((row) => (
                <div key={row.label} className="flex gap-2">
                  <dt className="w-40 shrink-0 text-zinc-500">{row.label}</dt>
                  <dd className="truncate">{row.value}</dd>
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
            <pre className="max-h-96 overflow-auto rounded bg-zinc-50 p-2 text-[11px] leading-snug dark:bg-zinc-900">
              {JSON.stringify(probe, null, 2)}
            </pre>
          )}
        </div>
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
    </div>
  )
}
