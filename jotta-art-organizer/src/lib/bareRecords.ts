// Which pictures lost what a person typed about them.
//
// The overwriting bug replaced a record's tags with the ones derived from the
// file, so the damage has a signature: a record carrying nothing but derived
// tags. Every category the app writes for itself is listed here, from the two
// modules that write them, so "nothing a person typed" is a statement about a
// known set rather than a guess at what a title is called.
//
// It cannot distinguish a record the bug emptied from one nobody ever got
// round to describing. Both need the same thing — someone to type — so the
// report is useful either way, and says so rather than claiming to know.
import type { MountpointRef } from '@/lib/api'
import { loadMetadata, type ArtworkTags, type Category } from '@/lib/metadata'
import {
  DIMENSIONS_CATEGORY_ID,
  X_RESOLUTION_CATEGORY_ID,
  Y_RESOLUTION_CATEGORY_ID,
  DATE_ACQUIRED_CATEGORY_ID,
  JOTTA_CREATED_CATEGORY_ID,
  FILE_CHANGED_CATEGORY_ID,
  EDITOR_CREATED_CATEGORY_ID,
  SOURCE_TYPE_CATEGORY_ID,
  CREDIT_CATEGORY_ID,
  CAMERA_CATEGORY_ID,
  PHOTO_USED_CATEGORY_ID,
  DRAW_TIME_CATEGORY_ID,
  AUTHORS_CATEGORY_ID,
  PROGRAM_NAME_CATEGORY_ID,
  COPYRIGHT_CATEGORY_ID,
} from '@/lib/imageMetadata'
import {
  PEOPLE_CATEGORY_ID,
  FAVORITED_CATEGORY_ID,
  YEAR_CATEGORY_ID,
  PHOTO_TAKEN_TIME_CATEGORY_ID,
  CREATION_TIME_CATEGORY_ID,
  GEO_DATA_CATEGORY_ID,
  SOURCE_CATEGORY_ID,
} from '@/lib/googlePhotosMetadata'

/** Categories the app fills in from a file or a Google record. Anything else
 *  on a record was typed by a person. */
export const DERIVED_CATEGORY_IDS = new Set<string>([
  DIMENSIONS_CATEGORY_ID,
  X_RESOLUTION_CATEGORY_ID,
  Y_RESOLUTION_CATEGORY_ID,
  DATE_ACQUIRED_CATEGORY_ID,
  JOTTA_CREATED_CATEGORY_ID,
  FILE_CHANGED_CATEGORY_ID,
  EDITOR_CREATED_CATEGORY_ID,
  SOURCE_TYPE_CATEGORY_ID,
  CREDIT_CATEGORY_ID,
  CAMERA_CATEGORY_ID,
  PHOTO_USED_CATEGORY_ID,
  DRAW_TIME_CATEGORY_ID,
  AUTHORS_CATEGORY_ID,
  PROGRAM_NAME_CATEGORY_ID,
  COPYRIGHT_CATEGORY_ID,
  PEOPLE_CATEGORY_ID,
  FAVORITED_CATEGORY_ID,
  YEAR_CATEGORY_ID,
  PHOTO_TAKEN_TIME_CATEGORY_ID,
  CREATION_TIME_CATEGORY_ID,
  GEO_DATA_CATEGORY_ID,
  SOURCE_CATEGORY_ID,
])

export type BareRecord = {
  md5: string
  path: string
  /** The derived tags it does carry, which say what the picture is even with
   *  nothing typed — a date and a camera make it recognisable. */
  derived: string
}

export type BareReport = {
  total: number
  /** Records carrying something a person typed. */
  described: number
  /** Records carrying only derived tags. */
  bare: number
  /** Which typed categories exist at all, and how many records have each —
   *  so "titles are missing" is distinguishable from "titles were never
   *  used". */
  typedCategories: { category: string; name: string; count: number }[]
  /**
   * Per folder, how many carry something typed and how many don't.
   *
   * Both, because the bare count alone is meaningless: a folder of six
   * thousand photographs nobody ever titled looks identical to a folder
   * whose titles were destroyed. A folder holding some of each is the one
   * worth looking at — that is describing that was started and is now
   * partly gone, or partly done.
   */
  byFolder: { folder: string; bare: number; described: number }[]
  examples: BareRecord[]
}

const EXAMPLE_LIMIT = 200

function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '(no folder recorded)' : path.slice(0, cut)
}

function typedIn(record: ArtworkTags): string[] {
  return Object.entries(record.tags)
    .filter(([id, values]) => values.length > 0 && !DERIVED_CATEGORY_IDS.has(id))
    .map(([id]) => id)
}

function nameOf(categories: Category[], id: string): string {
  return categories.find((c) => c.id === id)?.name || id
}

export async function findBareRecords(metadataLoc: MountpointRef): Promise<BareReport> {
  const store = await loadMetadata(metadataLoc)
  const report: BareReport = {
    total: store.artworks.length,
    described: 0,
    bare: 0,
    typedCategories: [],
    byFolder: [],
    examples: [],
  }

  const perCategory = new Map<string, number>()
  const perFolder = new Map<string, { bare: number; described: number }>()
  const tally = (folder: string) => {
    const held = perFolder.get(folder) ?? { bare: 0, described: 0 }
    perFolder.set(folder, held)
    return held
  }

  for (const record of store.artworks) {
    const typed = typedIn(record)
    const folder = folderOf(record.path ?? '')
    if (typed.length > 0) {
      report.described++
      tally(folder).described++
      for (const id of typed) perCategory.set(id, (perCategory.get(id) ?? 0) + 1)
      continue
    }

    report.bare++
    tally(folder).bare++
    if (report.examples.length < EXAMPLE_LIMIT) {
      report.examples.push({
        md5: record.md5,
        path: record.path ?? '',
        derived: Object.entries(record.tags)
          .filter(([, values]) => values.length > 0)
          .map(([id, values]) => `${nameOf(store.categories, id)}: ${values.join(', ')}`)
          .join(' · '),
      })
    }
  }

  report.typedCategories = [...perCategory.entries()]
    .map(([category, count]) => ({ category, name: nameOf(store.categories, category), count }))
    .sort((a, b) => b.count - a.count)
  // Folders where describing has happened come first, and by how much of it
  // is missing rather than by size: a folder with some typed tags and many
  // without is where something was lost or left half done, while a folder
  // with none at all is a folder nobody has described, however large.
  report.byFolder = [...perFolder.entries()]
    .map(([folder, counts]) => ({ folder, ...counts }))
    .sort((a, b) => {
      if ((a.described > 0) !== (b.described > 0)) return a.described > 0 ? -1 : 1
      return b.bare - a.bare
    })

  return report
}
