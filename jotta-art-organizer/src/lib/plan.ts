// The list of things that actually need doing, in the order they need doing.
//
// The app grew a tool per problem, each answering the question that was being
// asked at the time, each living on whichever page the conversation was on.
// That leaves nine entry points across five pages and no statement anywhere
// of what a person should actually do, or in what order — which for several
// of these matters, because running one before another undoes it.
//
// So: the jobs are written down here, once, with why each comes where it
// does. Whatever can be known about a job's state is worked out from what
// the app already records; the rest is ticked off by hand, because the app
// cannot know you have acted on advice it gave you.
import type { MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import {
  loadIntakeConfig,
  loadIntakeLog,
  summariseRun,
  intakeSources,
  folderLabel,
  type IntakeLogEntry,
} from '@/lib/photoIntake'
import { loadBatchManifest, batchIdFor } from '@/lib/batchTagImport'

const PLAN_FOLDER = '.jotta-art-organizer'
const PLAN_FILENAME = 'plan.json'

export type StepId = 'export-check' | 'describe' | 'sweep' | 'sidecars' | 'leftovers' | 'dedupe'

export type PlanStep = {
  id: StepId
  title: string
  /** Why it is where it is in the order. Every one of these is a reason
   *  something would go wrong if it were done earlier or later. */
  why: string
  href: string
  where: string
}

export const PLAN: PlanStep[] = [
  {
    id: 'export-check',
    title: 'Check the Google Photos export arrived',
    why: 'First, because the later steps move pictures and remove sidecars — both of which change what this check counts.',
    href: '/takeout',
    where: 'Before deleting from Google Photos',
  },
  {
    id: 'describe',
    title: 'Describe the export in bulk',
    why: 'Before anything is moved. Google keeps a picture’s date and place in a file beside it, and filing separates the two; read now, it is held against the picture’s content for good.',
    href: '/catalogue',
    where: 'Catalogue → Describe in bulk',
  },
  {
    id: 'sweep',
    title: 'File the artwork out of the photographs',
    why: 'After describing, so each piece arrives already knowing its date and place.',
    href: '/catalogue',
    where: 'Catalogue → Look for new artwork now',
  },
  {
    id: 'sidecars',
    title: 'Recover sidecars left behind',
    why: 'After filing, because filing is what leaves them behind — and after the export check, because clearing them changes what that check counts.',
    href: '/takeout',
    where: 'Before deleting from Google Photos → Sidecars left behind',
  },
  {
    id: 'leftovers',
    title: 'Clear out what moving left behind',
    why: 'Empty folders and decisions about pictures that have gone. Last of the filing jobs, since each earlier one creates more of both.',
    href: '/setup',
    where: 'Setup → Filing new artwork',
  },
  {
    id: 'dedupe',
    title: 'Find the duplicates',
    why: 'Last. Deduplicating earlier would remove copies the other steps still needed to find.',
    href: '/dedupe',
    where: 'Dedupe',
  },
]

type PlanState = { done: Partial<Record<StepId, string>> }

export async function loadPlanState(metadataLoc: MountpointRef): Promise<PlanState> {
  const stored = await readJsonFile<PlanState>(metadataLoc, `${PLAN_FOLDER}/${PLAN_FILENAME}`)
  return { done: stored?.done ?? {} }
}

export async function setStepDone(
  metadataLoc: MountpointRef,
  id: StepId,
  done: boolean
): Promise<PlanState> {
  const state = await loadPlanState(metadataLoc)
  if (done) state.done[id] = new Date().toISOString()
  else delete state.done[id]
  await writeJsonFile(metadataLoc, PLAN_FOLDER, PLAN_FILENAME, state)
  return state
}

/** What the app can say about a step on its own, from what it already
 *  records. Absent means it has no way of knowing — which is most of them,
 *  and why ticking off by hand exists. */
export type StepEvidence = Partial<Record<StepId, string>>

export async function gatherEvidence(metadataLoc: MountpointRef): Promise<StepEvidence> {
  const evidence: StepEvidence = {}

  const [log, config] = await Promise.all([
    loadIntakeLog(metadataLoc).catch(() => [] as IntakeLogEntry[]),
    loadIntakeConfig(metadataLoc).catch(() => null),
  ])

  const latest = (kinds: IntakeLogEntry['kind'][]) => log.find((entry) => kinds.includes(entry.kind))
  const when = (entry: IntakeLogEntry) => new Date(entry.at).toLocaleString()

  const filed = latest(['file'])
  if (filed) evidence.sweep = `${when(filed)} — ${summariseRun(filed)}`
  else {
    const looked = latest(['look'])
    if (looked) evidence.sweep = `${when(looked)} — ${summariseRun(looked)}, nothing filed yet`
  }

  const tidied = latest(['folders', 'forget', 'tidy'])
  if (tidied) evidence.leftovers = `${when(tidied)} — ${summariseRun(tidied)}`

  // The bulk import keeps a manifest per folder it has walked, so each place
  // the app looks for artwork can say whether it has been described.
  if (config) {
    const lines: string[] = []
    for (const folder of intakeSources(config)) {
      const loc = { device: folder.device, mountpoint: folder.mountpoint }
      const manifest = await loadBatchManifest(metadataLoc, batchIdFor(loc, folder.path)).catch(() => null)
      if (!manifest) continue
      lines.push(
        manifest.status === 'complete'
          ? `${folderLabel(folder)}: done, ${manifest.taggedCount.toLocaleString()} described`
          : `${folderLabel(folder)}: part-way, ${manifest.taggedCount.toLocaleString()} described so far, ${manifest.queue.length.toLocaleString()} folders left`
      )
    }
    if (lines.length > 0) evidence.describe = lines.join(' · ')
  }

  return evidence
}
