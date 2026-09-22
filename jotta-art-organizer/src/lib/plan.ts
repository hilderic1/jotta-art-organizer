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

/**
 * Whether a job comes round again, and on what.
 *
 * Worth distinguishing, because "one-time cleanup" is only true of some of
 * these. Most are not chores on a schedule but answers to an event — and an
 * event that hasn't happened needs no answer.
 */
export type Trigger = 'once' | 'new-export' | 'bulk-arrival' | 'housekeeping'

export type PlanStep = {
  id: StepId
  title: string
  /** Why it is where it is in the order. Every one of these is a reason
   *  something would go wrong if it were done earlier or later. */
  why: string
  trigger: Trigger
  /** The circumstance that calls for it, in words. */
  when: string
  href: string
  where: string
}

export const TRIGGER_HEADINGS: Record<Trigger, string> = {
  once: 'Once, because of how the library got here',
  'new-export': 'Each time you take a new Google Takeout export',
  'bulk-arrival': 'When a batch of pictures arrives some other way',
  housekeeping: 'Now and then, if it bothers you',
}

export const PLAN: PlanStep[] = [
  {
    id: 'export-check',
    title: 'Check the export arrived',
    trigger: 'new-export',
    when: 'Before deleting anything from Google Photos, on each new export. Not otherwise — it changes nothing and tells you nothing you need unless you are about to delete.',
    why: 'First of the export jobs, because the later ones move pictures and remove sidecars, and both change what this check counts.',
    href: '/takeout',
    where: 'Before deleting from Google Photos',
  },
  {
    id: 'describe',
    title: 'Describe a new batch in bulk',
    trigger: 'bulk-arrival',
    when: 'For pictures that arrive any way other than the app filing them — a new export, a folder copied in from elsewhere, anything uploaded to Jottacloud directly. Anything the app files is described as it lands, so that needs nothing.',
    why: 'Before the pictures are moved. Google keeps a picture’s date and place in a file beside it, and moving separates the two; read now, it is held against the picture’s content for good.',
    href: '/catalogue',
    where: 'Catalogue → Describe in bulk',
  },
  {
    id: 'sweep',
    title: 'File the artwork already sitting in the archive',
    trigger: 'once',
    when: 'Once per folder that was filling up before the app watched it. New work is found on its own when you open the app, so this is the backlog and nothing else.',
    why: 'After describing, so each piece arrives already knowing its date and place.',
    href: '/catalogue',
    where: 'Catalogue → Look for new artwork now',
  },
  {
    id: 'sidecars',
    title: 'Recover sidecars left behind',
    trigger: 'once',
    when: 'Only for pictures filed before filing learned to read the sidecar where the picture came from. Nothing filed from now on leaves one behind, so this should never be needed twice.',
    why: 'After filing, because filing is what left them behind — and after the export check, because clearing them changes what that check counts.',
    href: '/takeout',
    where: 'Before deleting from Google Photos → Sidecars left behind',
  },
  {
    id: 'leftovers',
    title: 'Clear out what moving left behind',
    trigger: 'housekeeping',
    when: 'Empty folders and decisions about pictures that have gone. Nothing depends on it and nothing breaks without it — it is tidiness, for when the clutter starts to show.',
    why: 'After the filing jobs, since each of them makes more of both.',
    href: '/setup',
    where: 'Setup → Filing new artwork',
  },
  {
    id: 'dedupe',
    title: 'Find the duplicates',
    trigger: 'bulk-arrival',
    when: 'After a batch arrives from a source that overlaps what you already have — two exports of the same library, a Dropbox folder and a Google one holding the same photographs.',
    why: 'Last. Deduplicating earlier removes copies the other jobs still needed in order to find things.',
    href: '/dedupe',
    where: 'Dedupe',
  },
]

/** The order they must be done in when several apply at once. The grouping
 *  is by circumstance; this is by dependency, and they are not the same. */
export const ORDER: StepId[] = PLAN.map((s) => s.id)

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
