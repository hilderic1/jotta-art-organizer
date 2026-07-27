'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, disconnectSession, type SessionStatus } from '@/lib/api'
import { FolderBrowser } from '@/components/FolderBrowser'

export default function Home() {
  const [status, setStatus] = useState<SessionStatus | null>(null)

  useEffect(() => {
    getSessionStatus().then(setStatus)
  }, [])

  if (status === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  if (!status.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-semibold">Jotta Art Organizer</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Import finished Picsart artwork and organize it into folders in your Jottacloud Archive.
        </p>
        <Link
          href="/setup"
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jotta Art Organizer</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Connected as {status.username}</p>
        </div>
        <button
          className="text-sm text-zinc-500 underline"
          onClick={async () => {
            await disconnectSession()
            setStatus({ authenticated: false })
          }}
        >
          Disconnect
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row">
        <Link
          href="/import"
          className="flex-1 rounded-lg bg-indigo-600 px-6 py-6 text-center text-lg font-semibold text-white hover:bg-indigo-500"
        >
          + Import artwork
        </Link>
        <Link
          href="/dedupe"
          className="flex-1 rounded-lg border-2 border-zinc-300 px-6 py-6 text-center text-lg font-semibold hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Remove duplicates
        </Link>
        <Link
          href="/backup"
          className="flex-1 rounded-lg border-2 border-zinc-300 px-6 py-6 text-center text-lg font-semibold hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Backup / copy
        </Link>
      </div>

      <Link href="/tags" className="text-sm text-indigo-600 underline dark:text-indigo-400">
        Classify artwork by tags →
      </Link>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Browse your Archive</h2>
        <FolderBrowser />
      </section>
    </div>
  )
}
