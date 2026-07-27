'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setup } from '@/lib/api'

export default function SetupPage() {
  const router = useRouter()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setup(token)
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.')
    } finally {
      setBusy(false)
    }
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
