'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  setup,
  getSessionStatus,
  disconnectSession,
  setMetadataLocation,
  type SessionStatus,
} from '@/lib/api'
import { resolveCatalogueLocation } from '@/lib/catalogueLocation'
import { FolderBrowser } from '@/components/FolderBrowser'
import { IntakeSettings } from '@/components/IntakeSettings'
import { CatalogueLocation } from '@/components/CatalogueLocation'
import { RestoreTags } from '@/components/RestoreTags'
import { BareRecordsReport } from '@/components/BareRecordsReport'

export default function SetupPage() {
  const router = useRouter()
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSessionStatus().then(async (session) => {
      // A reconnect clears the catalogue location from the session, and every
      // device has its own session — so being asked afresh is how a second,
      // empty catalogue gets started in the wrong mountpoint. Worked out from
      // the account instead, which is the only place the answer is true of,
      // before anything is shown as missing.
      if (session.authenticated && !session.metadataLocation) {
        const resolved = await resolveCatalogueLocation().catch(() => null)
        if (resolved?.loc) {
          await setMetadataLocation(resolved.loc).catch(() => null)
          setStatus({ ...session, metadataLocation: resolved.loc })
          return
        }
      }
      setStatus(session)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setup(token)
      router.push('/catalogue')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.')
    } finally {
      setBusy(false)
    }
  }

  // Account details and the archive browser used to live on the home page,
  // which now goes straight to Tags. They belong here, alongside connecting
  // and disconnecting, rather than on a landing page nobody stops at.
  if (status?.authenticated) {
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

        {/* Above filing, because filing depends on it: without a catalogue
            location there is nowhere to keep a setting, and the section below
            simply isn't there — which reads as the feature having vanished. */}
        <CatalogueLocation
          current={status.metadataLocation ?? null}
          onChange={(loc) =>
            setStatus((prev) => (prev?.authenticated ? { ...prev, metadataLocation: loc } : prev))
          }
        />

        {/* Directly under the catalogue location, because both are about the
            catalogue itself rather than about filing. */}
        {status.metadataLocation && <RestoreTags metadataLoc={status.metadataLocation} />}

        {/* After recovery rather than before it: the number only means
            something once every source has been taken from. */}
        {status.metadataLocation && <BareRecordsReport metadataLoc={status.metadataLocation} />}

        {status.metadataLocation && <IntakeSettings metadataLoc={status.metadataLocation} />}

        {/* A one-off check rather than a place you work, so it's linked from
            here instead of taking a slot in the nav. */}
        <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Deleting from Google Photos?</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Check first that your Takeout export fully arrived here, and up to which date it&rsquo;s complete.
          </p>
          <Link href="/takeout" className="mt-2 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            Check the export →
          </Link>
        </section>

        {/* Here rather than in the nav: none of it is part of using the app,
            and a permanent "to do" for jobs that mostly don't apply is a
            standing reproach for nothing. */}
        <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Sorting out a library</h2>
          <p className="mt-1 text-xs text-zinc-500">
            A handful of jobs for particular situations — pictures that were already in the archive
            before the app watched it, a fresh export from Google, a batch copied in from somewhere
            else. What each one is for, when it applies, and the order to do them in if several do.
          </p>
          <Link href="/plan" className="mt-2 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            Jobs, and when they apply →
          </Link>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Browse your Archive</h2>
          <FolderBrowser />
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold">Connect to Jottacloud</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Generate a one-time personal login token from your own Jottacloud account, then paste it below. This app
          exchanges it for an access token and stores it in an encrypted cookie on this device only &mdash; we never
          see your Jottacloud password.
        </p>
      </div>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>
          Go to{' '}
          <a
            className="text-indigo-600 underline dark:text-indigo-400"
            href="https://www.jottacloud.com/web/secure"
            target="_blank"
            rel="noreferrer"
          >
            jottacloud.com/web/secure
          </a>{' '}
          and log in.
        </li>
        <li>Open Settings → Security.</li>
        <li>Under &ldquo;Personal login token&rdquo;, click Generate.</li>
        <li>Copy the token and paste it here (each token can only be used once).</li>
      </ol>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <textarea
          required
          rows={4}
          className="rounded border border-zinc-300 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="Paste your personal login token here"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
