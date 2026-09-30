// Putting back tags that were written over.
//
// Describing on arrival used to replace a filed picture's record instead of
// folding into it, so hand-typed tags — titles above all — were lost. The
// records themselves are recoverable: each overwrite made a new revision of a
// shard file, and Jottacloud keeps previous versions of files, which can be
// downloaded from its website.
//
// This reads those downloaded shards and restores, per picture, only what the
// catalogue is now missing. Never a replacement: a tag that exists today is
// today's answer, whatever an older copy said. Content hash is the identity,
// so it does not matter that a picture has since been moved or renamed.
import { listFolder, listRevisions, readRevision, jottaTime, type MountpointRef } from '@/lib/api'
import { readJsonFile } from '@/lib/jsonStore'
import { readAllCachedShards } from '@/lib/shardCache'
import {
  loadArtworksByMd5,
  saveArtworkChanges,
  loadMetadata,
  ensureCategoriesForTags,
  explainDrop,
  type ArtworkTags,
  type Category,
} from '@/lib/metadata'
import { DERIVED_CATEGORY_IDS } from '@/lib/bareRecords'

export type RestorePlan = {
  /** Records read out of the files handed over. */
  read: number
  /** Pictures with something to put back. */
  pictures: number
  /** Tag categories restored, counted across all pictures. */
  tags: number
  /** Which categories they were, so a restore of nothing but dates is
   *  distinguishable from a restore of the titles. */
  byCategory: { category: string; count: number }[]
  /** A look at what would come back, for reading before agreeing to it. */
  examples: { md5: string; path: string; category: string; value: string }[]
  /** Records in the old files whose picture the catalogue has never heard of
   *  — restored whole, since nothing can be lost by adding them. */
  unknownPictures: number
  /** Tags not offered back because the catalogue would discard them on sight
   *  — a second-best date beside a real one. Counted so their absence from
   *  the total is explained rather than noticed. */
  discarded: number
  /** Why, per category, said in the store's own words. */
  discardedWhy: { category: string; count: number; why: string }[]
  upsert: ArtworkTags[]
  categories: Category[]
  /** Files that couldn't be read as a shard. */
  unreadable: string[]
}

function isRecord(value: unknown): value is ArtworkTags {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<ArtworkTags>
  return typeof r.md5 === 'string' && typeof r.tags === 'object' && r.tags !== null
}

/** A shard file is a bare array of records; older ones may have been wrapped. */
function recordsIn(parsed: unknown): ArtworkTags[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  if (parsed && typeof parsed === 'object') {
    const wrapped = (parsed as { artworks?: unknown; records?: unknown }).artworks ??
      (parsed as { records?: unknown }).records
    if (Array.isArray(wrapped)) return wrapped.filter(isRecord)
  }
  return []
}

const EXAMPLE_LIMIT = 40

/**
 * Works out what these old shard files could put back, without writing.
 *
 * A category counts as missing when the current record has nothing under it at
 * all. Anything present stays: the point is to fill holes, not to wind the
 * catalogue back to an earlier day.
 */
export async function planRestore(
  metadataLoc: MountpointRef,
  files: { name: string; text: string }[],
  opts?: {
    /** Leave out the categories the app fills in from the file itself. Those
     *  were never typed, so they were never lost — the app derives them again
     *  whenever it reads a picture. Restoring 57,000 of them rewrites every
     *  file in the catalogue to say what it already knows. */
    typedOnly?: boolean
  }
): Promise<RestorePlan> {
  const old: ArtworkTags[] = []
  const unreadable: string[] = []

  for (const file of files) {
    try {
      const records = recordsIn(JSON.parse(file.text))
      if (records.length === 0) unreadable.push(`${file.name} — no tag records in it`)
      else old.push(...records)
    } catch {
      unreadable.push(`${file.name} — not readable as JSON`)
    }
  }

  // Newest wins among the files handed over, in case several versions of one
  // shard are given at once: later files override earlier for the same md5.
  const byMd5 = new Map<string, ArtworkTags>()
  for (const record of old) byMd5.set(record.md5, record)

  const current = await loadArtworksByMd5(metadataLoc, byMd5.keys())
  const store = await loadMetadata(metadataLoc)

  const plan: RestorePlan = {
    read: old.length,
    pictures: 0,
    tags: 0,
    byCategory: [],
    examples: [],
    unknownPictures: 0,
    discarded: 0,
    discardedWhy: [],
    upsert: [],
    categories: store.categories,
    unreadable,
  }
  const counts = new Map<string, number>()
  const discardReasons = new Map<string, { count: number; why: string }>()

  for (const [md5, was] of byMd5) {
    const now = current.get(md5)
    if (!now) {
      // The catalogue has no record at all for this picture. Nothing can be
      // lost by putting the old one back whole.
      plan.upsert.push({ ...was, tags: { ...was.tags } })
      plan.unknownPictures++
      plan.pictures++
      for (const [id, values] of Object.entries(was.tags)) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
        plan.tags++
        if (plan.examples.length < EXAMPLE_LIMIT) {
          plan.examples.push({ md5, path: was.path ?? '', category: id, value: values.join(', ') })
        }
      }
      continue
    }

    const tags: Record<string, string[]> = {}
    for (const [id, values] of Object.entries(now.tags)) tags[id] = [...values]
    let restored = 0

    for (const [id, values] of Object.entries(was.tags)) {
      if (values.length === 0) continue
      if (opts?.typedOnly && DERIVED_CATEGORY_IDS.has(id)) continue
      const held = tags[id]
      if (held && held.length > 0) continue
      // Would the catalogue keep it? A retired category, a value no longer in
      // its list, or a second-best date beside a real one is deleted the
      // moment the record is read, so offering it back is offering to rewrite
      // a file to no effect. The reason comes from the store rather than being
      // guessed at here.
      const why = explainDrop(id, values, tags)
      if (why) {
        plan.discarded++
        const held = discardReasons.get(id) ?? { count: 0, why }
        held.count++
        discardReasons.set(id, held)
        continue
      }
      tags[id] = [...values]
      restored++
      counts.set(id, (counts.get(id) ?? 0) + 1)
      if (plan.examples.length < EXAMPLE_LIMIT) {
        plan.examples.push({ md5, path: now.path ?? was.path ?? '', category: id, value: values.join(', ') })
      }
    }

    if (restored > 0) {
      plan.upsert.push({ ...now, tags })
      plan.pictures++
      plan.tags += restored
    }
  }

  plan.discardedWhy = [...discardReasons.entries()]
    .map(([category, held]) => ({ category, count: held.count, why: held.why }))
    .sort((a, b) => b.count - a.count)
  plan.byCategory = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
  // Values coming back need to exist in the vocabulary, or a restored tag is
  // invisible to the filters that read category lists.
  for (const record of plan.upsert) {
    plan.categories = ensureCategoriesForTags(plan.categories, record.tags)
  }

  return plan
}

const SHARDS_FOLDER = '.jotta-art-organizer/artwork-shards'
const LEGACY_PATH = '.jotta-art-organizer/metadata.json'

/**
 * The catalogue as it was before it was split into per-hash files.
 *
 * That single file is read when migrating and never written again, so it
 * still holds every record as of the day the split happened — including tags
 * that have since been written over. It reaches back only that far, which is
 * its limit and worth saying rather than discovering.
 */
export async function readLegacyStore(
  metadataLoc: MountpointRef
): Promise<{ name: string; text: string } | null> {
  const raw = await readJsonFile<unknown>(metadataLoc, LEGACY_PATH).catch(() => null)
  if (!raw) return null
  return { name: 'metadata.json (before the catalogue was split up)', text: JSON.stringify(raw) }
}

/**
 * What this device is still holding of the catalogue.
 *
 * The cache is refreshed per shard only when Jottacloud says that shard has
 * changed, so a device that hasn't loaded the catalogue since the damage is
 * holding the records as they were. Opening the Catalogue on such a device
 * replaces them, which is why this is worth reaching for early and on every
 * device before anything else is done there.
 */
export async function readDeviceCache(
  metadataLoc: MountpointRef
): Promise<{ files: { name: string; text: string }[]; shards: number; records: number }> {
  const scope = `${metadataLoc.device}/${metadataLoc.mountpoint}`
  const cached = await readAllCachedShards(scope)
  const files: { name: string; text: string }[] = []
  let records = 0
  for (const [shardKey, entry] of cached) {
    if (!entry?.records?.length) continue
    records += entry.records.length
    files.push({
      name: `${shardKey}.json (this device, held since ${entry.modified || 'an unknown time'})`,
      text: JSON.stringify(entry.records),
    })
  }
  return { files, shards: files.length, records }
}

export type HistoryReport = {
  /** Shard files looked at. */
  files: number
  /** Ones with any history kept at all. */
  withHistory: number
  /** Ones where a version older than the cutoff exists — the recoverable ones. */
  usable: number
  /** The oldest version found anywhere, so "history doesn't reach back far
   *  enough" is a statement of fact rather than a guess. */
  oldest?: number
  /** Per file, for reading: what is available and what was chosen. */
  detail: { name: string; kept: number; chosen?: number; chosenAt?: number; oldestAt?: number; error?: string }[]
  /** The chosen versions' contents, ready for planRestore. */
  files_: { name: string; text: string }[]
}

/**
 * Reads the history of every shard file and fetches, for each, the newest
 * version older than `before`.
 *
 * There are up to 256 of these, so doing it by hand is not a serious
 * suggestion. How far Jottacloud's history reaches is its own business and
 * undocumented, so this reports what it found rather than assuming: a file
 * whose oldest kept version is already after the cutoff cannot be recovered,
 * and saying so is more use than a restore that quietly covers half the
 * library.
 */
export async function gatherHistory(
  metadataLoc: MountpointRef,
  before: Date,
  opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal }
): Promise<HistoryReport> {
  const listing = await listFolder(metadataLoc, SHARDS_FOLDER)
  const shards = listing.files.filter((f) => f.name.endsWith('.json') && f.name !== '_index.json')
  const cutoff = before.getTime()

  const report: HistoryReport = { files: shards.length, withHistory: 0, usable: 0, detail: [], files_: [] }
  let done = 0

  for (const shard of shards) {
    if (opts?.signal?.aborted) break
    try {
      const revisions = await listRevisions(metadataLoc, shard.path)
      const dated = revisions
        .map((r) => ({ r, at: jottaTime(r.modified) || jottaTime(r.created) || 0 }))
        .filter((x) => x.at > 0)
      const older = dated.filter((x) => x.at < cutoff).sort((a, b) => b.at - a.at)
      const oldestAt = dated.length > 0 ? Math.min(...dated.map((x) => x.at)) : undefined
      if (revisions.length > 1) report.withHistory++
      if (oldestAt && (!report.oldest || oldestAt < report.oldest)) report.oldest = oldestAt

      if (older.length === 0) {
        report.detail.push({ name: shard.name, kept: revisions.length, oldestAt })
      } else {
        const chosen = older[0]
        const text = await readRevision(metadataLoc, shard.path, chosen.r.number)
        report.files_.push({ name: `${shard.name}@${chosen.r.number}`, text })
        report.usable++
        report.detail.push({
          name: shard.name,
          kept: revisions.length,
          chosen: chosen.r.number,
          chosenAt: chosen.at,
          oldestAt,
        })
      }
    } catch (err) {
      report.detail.push({
        name: shard.name,
        kept: 0,
        error: err instanceof Error ? err.message : 'Could not read its history.',
      })
    }
    opts?.onProgress?.(++done, shards.length)
  }

  return report
}

export async function applyRestore(metadataLoc: MountpointRef, plan: RestorePlan): Promise<number> {
  if (plan.upsert.length === 0) return 0
  await saveArtworkChanges(metadataLoc, plan.categories, { upsert: plan.upsert })
  return plan.upsert.length
}
