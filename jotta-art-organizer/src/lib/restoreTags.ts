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
import type { MountpointRef } from '@/lib/api'
import {
  loadArtworksByMd5,
  saveArtworkChanges,
  loadMetadata,
  ensureCategoriesForTags,
  type ArtworkTags,
  type Category,
} from '@/lib/metadata'

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
  files: { name: string; text: string }[]
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
    upsert: [],
    categories: store.categories,
    unreadable,
  }
  const counts = new Map<string, number>()

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
      const held = tags[id]
      if (held && held.length > 0) continue
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

export async function applyRestore(metadataLoc: MountpointRef, plan: RestorePlan): Promise<number> {
  if (plan.upsert.length === 0) return 0
  await saveArtworkChanges(metadataLoc, plan.categories, { upsert: plan.upsert })
  return plan.upsert.length
}
