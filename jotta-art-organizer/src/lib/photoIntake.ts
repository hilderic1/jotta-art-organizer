// Finding the artist's own work among everything the iPad backs up.
//
// PicsArt saves to the iPad's camera roll, and Jottacloud's app backs the
// whole roll up — so her pieces arrive mixed in with photographs, screenshots
// and everything else. This picks them out and copies them into the artwork
// folder, using what the files themselves say rather than guessing from
// filenames.
//
// Copies rather than moves, deliberately. The backup is meant to hold
// everything the iPad has; deleting from it would fight the phone, which
// still has the picture and would simply upload it again.
import {
  walkTree,
  copyFile,
  listFolder,
  type MountpointRef,
  type WalkEntry,
} from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { readArtworkMetadata, type ArtworkFileMetadata } from '@/lib/imageMetadata'

const INTAKE_FOLDER = '.jotta-art-organizer'
const CONFIG_FILENAME = 'intake.json'
const EXAMINED_FILENAME = 'intake-examined.json'

export type FolderRef = MountpointRef & { path: string }

export type IntakeConfig = {
  /** Where the iPad's pictures land — Jottacloud's own photo backup. */
  source: FolderRef
  /** Where her artwork is kept. */
  dest: FolderRef
  enabled: boolean
}

export type IntakeMatch = {
  md5: string
  path: string
  name: string
  /** Why this was taken for her work, shown so a wrong guess is visible
   *  rather than mysterious. */
  reason: string
}

export type IntakeScan = {
  matches: IntakeMatch[]
  /** Candidates left unexamined because the run hit its budget. Reported so
   *  a partial answer never reads as a complete one. */
  remaining: number
  examined: number
}

// A picture is hers if the file says so. Every one of these is something a
// program wrote about how the image was made — not an inference from the
// picture, and not from its name, which an export can lose.
export function artworkReason(meta: ArtworkFileMetadata | null): string | null {
  if (!meta) return null

  // PicsArt records the editing session in the image description, and its
  // working stats alongside. Nothing else writes these.
  if (meta.editorCreatedAtEpochSeconds != null) return 'PicsArt editing session'
  if (
    meta.editorDrawTimeMs != null ||
    meta.editorPhotosAdded != null ||
    meta.editorLayersUsed != null ||
    meta.editorBrushesUsed != null
  ) {
    return 'PicsArt working stats'
  }
  if (meta.programName && /picsart/i.test(meta.programName)) return `Made with ${meta.programName}`

  // C2PA content credentials: a signed claim by the tool that made the file,
  // which is how an AI-generated or AI-edited picture identifies itself.
  if (meta.sourceType) return `Content credentials: ${meta.sourceType}`
  if (meta.credit && /\bai\b|generat/i.test(meta.credit)) return meta.credit

  return null
}

export async function loadIntakeConfig(metadataLoc: MountpointRef): Promise<IntakeConfig | null> {
  return readJsonFile<IntakeConfig>(metadataLoc, `${INTAKE_FOLDER}/${CONFIG_FILENAME}`)
}

export async function saveIntakeConfig(metadataLoc: MountpointRef, config: IntakeConfig): Promise<void> {
  await writeJsonFile(metadataLoc, INTAKE_FOLDER, CONFIG_FILENAME, config)
}

// Hashes already looked at and found not to be artwork. Without this every
// start would re-read the header of every holiday photo in the backup, which
// is the one genuinely expensive part of the scan. Kept in the account rather
// than on the device so a second device doesn't repeat the work.
async function loadExamined(metadataLoc: MountpointRef): Promise<Set<string>> {
  const stored = await readJsonFile<{ notArtwork: string[] }>(
    metadataLoc,
    `${INTAKE_FOLDER}/${EXAMINED_FILENAME}`
  )
  return new Set(stored?.notArtwork ?? [])
}

async function saveExamined(metadataLoc: MountpointRef, examined: Set<string>): Promise<void> {
  await writeJsonFile(metadataLoc, INTAKE_FOLDER, EXAMINED_FILENAME, {
    notArtwork: [...examined],
  })
}

// Set aside by hand: a picture that carries the marks of her tools but isn't
// work she wants filed — a screenshot of the editor, a photograph she edited
// once. Kept in the same list as the ones the scan rejected, because it means
// exactly the same thing to every later run: don't offer this again.
export async function rememberNotArtwork(metadataLoc: MountpointRef, md5s: string[]): Promise<void> {
  const examined = await loadExamined(metadataLoc)
  for (const md5 of md5s) examined.add(md5)
  await saveExamined(metadataLoc, examined)
}

export async function countNotArtwork(metadataLoc: MountpointRef): Promise<number> {
  return (await loadExamined(metadataLoc)).size
}

// Empties the list, so everything gets looked at again. The way back from a
// "never" pressed by mistake — without it, one tap would be final, and a
// hidden final decision is a bad thing to build.
export async function forgetNotArtwork(metadataLoc: MountpointRef): Promise<void> {
  await saveExamined(metadataLoc, new Set())
}

// Reading a header is one request per file, so a first run over a full camera
// roll is bounded and resumed on the next start rather than made to finish.
const EXAMINE_BUDGET = 300
const EXAMINE_CONCURRENCY = 6

export async function scanIntake(
  metadataLoc: MountpointRef,
  config: IntakeConfig,
  opts?: { onProgress?: (examined: number, total: number) => void }
): Promise<IntakeScan> {
  const sourceLoc = { device: config.source.device, mountpoint: config.source.mountpoint }
  const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }

  const [source, dest, examined] = await Promise.all([
    walkTree(sourceLoc, config.source.path),
    walkTree(destLoc, config.dest.path),
    loadExamined(metadataLoc),
  ])

  // Already filed, or already judged not to be hers. Content hashes, so a
  // renamed copy is still recognised as the same picture.
  const alreadyThere = new Set(dest.files.map((f) => f.md5))
  const candidates = source.files.filter((f) => !alreadyThere.has(f.md5) && !examined.has(f.md5))

  const batch = candidates.slice(0, EXAMINE_BUDGET)
  const matches: IntakeMatch[] = []
  let done = 0

  let cursor = 0
  async function worker() {
    for (;;) {
      const file: WalkEntry | undefined = batch[cursor++]
      if (!file) return
      let reason: string | null = null
      try {
        reason = artworkReason(await readArtworkMetadata(sourceLoc, file.absPath))
      } catch {
        // An unreadable file is left for next time rather than written off:
        // a dropped request says nothing about what the picture is.
        done++
        opts?.onProgress?.(done, batch.length)
        continue
      }
      if (reason) {
        matches.push({
          md5: file.md5,
          path: file.absPath,
          name: file.absPath.split('/').pop() ?? file.md5,
          reason,
        })
      } else {
        examined.add(file.md5)
      }
      done++
      opts?.onProgress?.(done, batch.length)
    }
  }

  await Promise.all(Array.from({ length: EXAMINE_CONCURRENCY }, worker))
  await saveExamined(metadataLoc, examined).catch(() => {
    // Losing this costs a repeated scan, never a wrong result.
  })

  return { matches, remaining: candidates.length - batch.length, examined: batch.length }
}

export type IntakeResult = { copied: number; failed: { name: string; error: string }[] }

// One at a time: a copy is a server-side operation on Jottacloud's side, and
// a burst of them against a folder being written to is how the earlier copy
// work produced half-written trees.
export async function fileIntake(config: IntakeConfig, matches: IntakeMatch[]): Promise<IntakeResult> {
  const sourceLoc = { device: config.source.device, mountpoint: config.source.mountpoint }
  const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }
  const failed: IntakeResult['failed'] = []
  let copied = 0

  // Names collide across a camera roll — two exports a month apart can share
  // one. Checked against what's actually in the folder, once, rather than
  // trusting the name to be free.
  const existing = new Set(
    (await listFolder(destLoc, config.dest.path).catch(() => null))?.files.map((f) => f.name) ?? []
  )

  for (const match of matches) {
    const name = uniqueName(match.name, existing)
    try {
      // Joined rather than interpolated: a destination at the root of a
      // mountpoint has an empty path, which would otherwise give "/name".
      await copyFile(sourceLoc, match.path, destLoc, [config.dest.path, name].filter(Boolean).join('/'))
      existing.add(name)
      copied++
    } catch (err) {
      failed.push({ name: match.name, error: err instanceof Error ? err.message : 'Copy failed.' })
    }
  }

  return { copied, failed }
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}
