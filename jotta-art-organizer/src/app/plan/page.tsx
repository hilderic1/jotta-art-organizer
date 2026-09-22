'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getSessionStatus, type SessionStatus, type MountpointRef } from '@/lib/api'
import {
  PLAN,
  loadPlanState,
  setStepDone,
  gatherEvidence,
  type StepEvidence,
  type StepId,
} from '@/lib/plan'

export default function PlanPage() {
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [done, setDone] = useState<Partial<Record<StepId, string>>>({})
  const [evidence, setEvidence] = useState<StepEvidence>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<StepId | null>(null)

  useEffect(() => {
    let ignore = false
    getSessionStatus()
      .then(async (status) => {
        if (ignore) return
        setSession(status)
        if (!status.authenticated || !status.metadataLocation) return
        const loc: MountpointRef = status.metadataLocation
        const [state, found] = await Promise.all([
          loadPlanState(loc).catch(() => ({ done: {} })),
          gatherEvidence(loc).catch(() => ({})),
        ])
        if (ignore) return
        setDone(state.done)
        setEvidence(found)
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [])

  async function toggle(id: StepId) {
    if (!session?.authenticated || !session.metadataLocation) return
    setSaving(id)
    try {
      const next = await setStepDone(session.metadataLocation, id, !done[id])
      setDone(next.done)
    } catch {
      // The tick is a note to yourself; failing to save one is not worth an
      // error over work that has actually been done.
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  if (!session?.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your Jottacloud account first.</p>
        <Link href="/setup" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Connect Jottacloud
        </Link>
      </div>
    )
  }

  const remaining = PLAN.filter((step) => !done[step.id])
  const next = remaining[0]

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">What needs doing</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Sorting out a library that has been through a Google Photos export, a phone backup and a few
          years takes a handful of jobs, each done once. The order matters — several of these would undo
          the one before if run first — so they&rsquo;re listed in it, with the reason.
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          Finding new artwork and describing what arrives happen on their own. Nothing below is part of
          using the app day to day.
        </p>
      </div>

      {next ? (
        <p className="rounded border border-indigo-300 bg-indigo-50 p-3 text-sm dark:border-indigo-800 dark:bg-indigo-950">
          Next: <strong>{next.title}</strong> — <Link href={next.href} className="text-indigo-700 underline dark:text-indigo-300">{next.where}</Link>
        </p>
      ) : (
        <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          All done. The app looks for new artwork and describes it on arrival by itself from here.
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {PLAN.map((step, index) => {
          const at = done[step.id]
          return (
            <li
              key={step.id}
              className={`rounded-lg border p-3 ${
                at
                  ? 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950'
                  : 'border-zinc-300 dark:border-zinc-700'
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(at)}
                  disabled={saving === step.id}
                  onChange={() => toggle(step.id)}
                  aria-label={`Done: ${step.title}`}
                  className="mt-1 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${at ? 'text-zinc-500 line-through' : ''}`}>
                    {index + 1}. {step.title}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{step.why}</p>
                  {/* What the app knows by itself, where it knows anything.
                      Most of these it cannot know — it has no way of telling
                      whether you acted on advice it gave you — which is what
                      the tick is for. */}
                  {evidence[step.id] && (
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{evidence[step.id]}</p>
                  )}
                  <p className="mt-1 text-xs">
                    <Link href={step.href} className="text-indigo-600 hover:underline dark:text-indigo-400">
                      {step.where} →
                    </Link>
                    {at && (
                      <span className="ml-2 text-zinc-400">
                        ticked off {new Date(at).toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      <p className="text-xs text-zinc-500">
        Everything else in the app is there to answer a question when a number looks wrong — where the
        pictures are, what a folder really holds, what a file records about itself. None of it needs
        running on any schedule.
      </p>
    </div>
  )
}
