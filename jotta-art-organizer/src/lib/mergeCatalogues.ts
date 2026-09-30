// Folding one catalogue into another.
//
// Answering "where is your catalogue?" wrongly once starts a second one, and
// whatever gets tagged before the mistake is noticed lands in it. Both are
// real work, so the answer is not to pick one and abandon the other.
//
// The data model makes this tractable: a tag record is keyed by the picture's
// content hash, not by where the picture sits, so records from two catalogues
// line up without any matching or guessing. What needs a decision is only
// what to do when both describe the same picture — and that differs by what
// kind of category it is.
import type { MountpointRef } from '@/lib/api'
import {
  loadMetadata,
  saveArtworkChanges,
  type ArtworkTags,
  type Category,
  type MetadataStore,
} from '@/lib/metadata'

export type MergePlan = {
  /** Pictures described in the other catalogue and not in this one. These
   *  are the ones that were lost from view, and they carry over whole. */
  added: number
  /** Described in both, with something to add from the other. */
  enriched: number
  /** Described in both, with nothing the other could add. */
  untouched: number
  /** Where both hold a different single answer — a title, a note — and this
   *  catalogue's was kept. Listed, because a lost title is exactly the thing
   *  worth knowing about. */
  conflicts: { md5: string; category: string; kept: string; discarded: string }[]
  /** Categories the other catalogue had that this one didn't. */
  newCategories: string[]
  /** New values added to categories both share. */
  newValues: number
  /** Ready to write, when the plan is accepted. */
  upsert: ArtworkTags[]
  categories: Category[]
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Works out what folding `from` into `into` would do, without writing.
 *
 * Vocabulary categories — style, subject, the people in a picture — are
 * unioned: two catalogues each knowing something true about a picture both
 * remain true. Free-text categories are not, because a title is one answer,
 * and two titles is not a richer record but a broken one; there this
 * catalogue's answer is kept and the other reported.
 */
export function planMerge(into: MetadataStore, from: MetadataStore): MergePlan {
  const freeText = new Set(
    [...into.categories, ...from.categories].filter((c) => c.freeText).map((c) => c.id)
  )

  const categories: Category[] = into.categories.map((c) => ({ ...c, values: [...c.values] }))
  const byId = new Map(categories.map((c) => [c.id, c]))
  const newCategories: string[] = []
  let newValues = 0

  for (const other of from.categories) {
    const held = byId.get(other.id)
    if (!held) {
      const copy = { ...other, values: [...other.values] }
      categories.push(copy)
      byId.set(copy.id, copy)
      newCategories.push(other.name || other.id)
      continue
    }
    if (held.freeText) continue
    for (const value of other.values) {
      if (held.values.includes(value)) continue
      held.values.push(value)
      newValues++
    }
  }

  const mine = new Map(into.artworks.map((a) => [a.md5, a]))
  const plan: MergePlan = {
    added: 0,
    enriched: 0,
    untouched: 0,
    conflicts: [],
    newCategories,
    newValues,
    upsert: [],
    categories,
  }

  for (const other of from.artworks) {
    const held = mine.get(other.md5)
    if (!held) {
      // Carried over as it stands, including where the picture was in the
      // other catalogue: path is a note of where it was last seen, and a
      // wrong one is corrected the next time anything reads that picture.
      plan.upsert.push({ ...other, tags: { ...other.tags } })
      plan.added++
      continue
    }

    const tags: Record<string, string[]> = {}
    for (const [id, values] of Object.entries(held.tags)) tags[id] = [...values]
    let changed = false

    for (const [id, values] of Object.entries(other.tags)) {
      const held_ = tags[id]
      if (!held_ || held_.length === 0) {
        tags[id] = [...values]
        changed = true
        continue
      }
      if (freeText.has(id)) {
        if (!sameValues(held_, values)) {
          plan.conflicts.push({
            md5: other.md5,
            category: id,
            kept: held_.join(', '),
            discarded: values.join(', '),
          })
        }
        continue
      }
      for (const value of values) {
        if (tags[id].includes(value)) continue
        tags[id].push(value)
        changed = true
      }
    }

    if (changed) {
      plan.upsert.push({ ...held, tags })
      plan.enriched++
    } else {
      plan.untouched++
    }
  }

  return plan
}

/** Reads both catalogues and works out the plan. Nothing is written. */
export async function planCatalogueMerge(
  into: MountpointRef,
  from: MountpointRef
): Promise<MergePlan> {
  const [target, source] = await Promise.all([loadMetadata(into), loadMetadata(from)])
  return planMerge(target, source)
}

/**
 * Writes a plan into the catalogue it was made for.
 *
 * Only ever adds: no record is removed, and the catalogue merged from is left
 * exactly as it was, so a merge that turns out wrong costs nothing that
 * can't be sorted out afterwards.
 */
export async function applyMerge(into: MountpointRef, plan: MergePlan): Promise<number> {
  await saveArtworkChanges(into, plan.categories, { upsert: plan.upsert })
  return plan.upsert.length
}
