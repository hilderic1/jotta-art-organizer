// Finding the artist's own work among everything the iPad backs up.
//
// PicsArt saves to the iPad's camera roll, and Jottacloud's app backs the
// whole roll up — so her pieces arrive mixed in with photographs, screenshots
// and everything else. This picks them out and copies them into the artwork
// folder, using what the files themselves say rather than guessing from
// filenames.
//
// Copying and moving are both offered, and which one is right depends on what
// the source folder is for. A phone backup is meant to hold everything the
// phone has, so copying leaves it intact; a photo library you actually read is
// better off without the artwork mixed in, so moving takes it out. Moving is
// therefore a setting rather than a decision made here — see IntakeConfig.mode.
import {
  walkTree,
  copyFile,
  deleteFile,
  deleteFolder,
  listFolder,
  type MountpointRef,
  type WalkEntry,
} from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'
import { readArtworkMetadata, type ArtworkFileMetadata } from '@/lib/imageMetadata'

const INTAKE_FOLDER = '.jotta-art-organizer'
const CONFIG_FILENAME = 'intake.json'
const EXAMINED_FILENAME = 'intake-examined.json'
const LOG_FILENAME = 'intake-log.json'

export type FolderRef = MountpointRef & { path: string }

export type IntakeConfig = {
  /** The first place to look — where the iPad's pictures land. Kept as its
   *  own field because every configuration saved before there could be more
   *  than one has it, and those must keep working untouched. */
  source: FolderRef
  /** Every place to look, this one included. Absent in older configurations,
   *  which is what `intakeSources` is for. */
  sources?: FolderRef[]
  /** Where her artwork is kept. */
  dest: FolderRef
  enabled: boolean
  /** Whether filing takes the picture out of the source folder as well as
   *  putting it in the destination. Absent means copy, which is what every
   *  setup saved before moving existed. */
  mode?: 'copy' | 'move'
  /** Read every picture that hasn't been read yet, rather than stopping at
   *  the usual budget. For sweeping a whole archive once, where stopping
   *  after 300 means pressing the button a hundred times. */
  lookUntilDone?: boolean
  /** The tools whose output is her work. Which programs those are is hers
   *  to say — the app has no business deciding that a picture is art
   *  because some AI was involved in it. */
  artTools?: string[]
}

export function artTools(config: IntakeConfig): string[] {
  const listed = config.artTools?.map((t) => t.trim()).filter(Boolean) ?? []
  return listed.length > 0 ? listed : DEFAULT_ART_TOOLS
}

/** Everywhere to look, old configurations included. */
export function intakeSources(config: IntakeConfig): FolderRef[] {
  const listed = config.sources?.filter(Boolean) ?? []
  return listed.length > 0 ? listed : config.source ? [config.source] : []
}

/** How a folder is named on screen. One function, because naming it by its
 *  path alone turned "Archive/Google Photos" into "Google Photos" in one
 *  place and not the other. */
export function folderLabel(folder: FolderRef): string {
  return folder.path ? `${folder.mountpoint}/${folder.path}` : folder.mountpoint
}

export function sourcesLabel(config: IntakeConfig): string {
  const sources = intakeSources(config)
  if (sources.length === 0) return 'nowhere yet'
  if (sources.length === 1) return folderLabel(sources[0])
  return `${folderLabel(sources[0])} and ${sources.length - 1} other${sources.length === 2 ? '' : 's'}`
}

/** Works for a configured folder and for a match alike: both say which
 *  device and mountpoint they belong to, which with several sources is no
 *  longer something a caller can assume. */
function locOf(where: { device: string; mountpoint: string }): MountpointRef {
  return { device: where.device, mountpoint: where.mountpoint }
}

export type IntakeMatch = {
  md5: string
  path: string
  name: string
  /** Which of the source folders it came out of. Carried per match rather
   *  than assumed, since there can be several and they can be on different
   *  devices. */
  device: string
  mountpoint: string
  /** Why this was taken for her work, shown so a wrong guess is visible
   *  rather than mysterious. */
  reason: string
}

export type IntakeScan = {
  matches: IntakeMatch[]
  /** Pictures whose content is already in the destination, yet which are
   *  still sitting in the photo folder — what copying leaves behind, and
   *  what separating the two folders means getting rid of. Only collected
   *  when moving, because copying is the choice to keep both. */
  strays: IntakeMatch[]
  /** Candidates left unexamined because the run hit its budget. Reported so
   *  a partial answer never reads as a complete one. */
  remaining: number
  examined: number
  /** Called off before it finished. What it had already read is kept, but
   *  what it found is not offered — half a look is not an answer. */
  stopped: boolean
  /** The line written to the run log, so the screen can show what it did
   *  without recounting it. Null when the look never got past the walk. */
  logged: IntakeLogEntry | null
}

/** The tools whose output counts as her work, unless the setting says
 *  otherwise. One entry, because one program makes the art. */
export const DEFAULT_ART_TOOLS = ['PicsArt']

// Compared with the punctuation and spacing thrown away, so "PicsArt",
// "Pics Art" and "picsart 24.1" are all the same name.
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Which of the art tools a file says made it, if any.
 *
 * A tool signs its work in several different places — the program name, the
 * IPTC credit, the C2PA claim, the copyright line — and which one you get
 * depends on how the piece was made. A drawing carries the working stats;
 * something generated by the same app's AI often carries nothing but a
 * signed claim naming it. Same tool, same artist, so all the places it
 * might sign are read together.
 */
function artToolNamed(meta: ArtworkFileMetadata, tools: string[]): string | null {
  const said = [meta.programName, meta.credit, meta.sourceType, meta.copyright, ...(meta.authors ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalise)
  for (const tool of tools) {
    const wanted = normalise(tool)
    if (wanted && said.some((value) => value.includes(wanted))) return tool
  }
  return null
}

/**
 * A picture is hers if the file says which tool made it, and that tool is one
 * of hers. Everything read here is something a program wrote about how the
 * image was made — never an inference from the picture, and never its name,
 * which an export can lose.
 *
 * Deliberately not "was AI involved". A photograph touched up on a phone
 * carries a signed claim saying AI-assisted, and it is still a photograph:
 * AI involvement is not authorship. What makes a piece hers is that she made
 * it in her tool, whether she drew it, generated it, or both.
 */
export function artworkReason(
  meta: ArtworkFileMetadata | null,
  tools: string[] = DEFAULT_ART_TOOLS
): string | null {
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

  const tool = artToolNamed(meta, tools)
  if (!tool) return null
  return meta.sourceType && /algorithmic|generat/i.test(meta.sourceType)
    ? `Generated in ${tool}`
    : `Made with ${tool}`
}

// What each run did, kept in the account rather than on the screen. The
// banner is on the Catalogue's folder-picking screen and disappears the
// moment a folder is chosen, so anything it says about a finished run is
// gone a second later — and a run that copies, removes and describes is
// exactly the sort of thing you want to be able to look up afterwards.
export type IntakeLogEntry = {
  at: string
  kind: 'look' | 'file' | 'tidy' | 'folders' | 'forget'
  /** Absent members didn't apply to that kind of run, rather than being zero. */
  folders?: number
  pictures?: number
  alreadyFiled?: number
  setAside?: number
  read?: number
  found?: number
  remaining?: number
  filed?: number
  removed?: number
  described?: number
  failed?: number
  stopped?: boolean
  /** Empty folders removed from the photo folder. */
  foldersRemoved?: number
  /** Decisions dropped because the picture is no longer in the photo folder. */
  forgotten?: number
}

// Enough to answer "what happened last time?" without becoming a file that
// grows forever in an account meant for pictures.
const LOG_LIMIT = 25

export async function loadIntakeLog(metadataLoc: MountpointRef): Promise<IntakeLogEntry[]> {
  const stored = await readJsonFile<{ runs: IntakeLogEntry[] }>(
    metadataLoc,
    `${INTAKE_FOLDER}/${LOG_FILENAME}`
  )
  return stored?.runs ?? []
}

export async function appendIntakeLog(
  metadataLoc: MountpointRef,
  entry: IntakeLogEntry
): Promise<IntakeLogEntry[]> {
  const runs = [entry, ...(await loadIntakeLog(metadataLoc))].slice(0, LOG_LIMIT)
  await writeJsonFile(metadataLoc, INTAKE_FOLDER, LOG_FILENAME, { runs })
  return runs
}

/** What to call each kind of run. A switch over the union rather than a
 *  chain of ternaries, so adding a kind can't quietly leave it wearing an
 *  older kind's name in a list of them. */
export function runLabel(kind: IntakeLogEntry['kind']): string {
  switch (kind) {
    case 'look':
      return 'Looked'
    case 'file':
      return 'Filed'
    case 'tidy':
      return 'Tidied'
    case 'folders':
      return 'Removed empty folders'
    case 'forget':
      return 'Forgot old decisions'
  }
}

/**
 * One line per run, phrased here so the banner and Setup say the same thing.
 *
 * Every clause is something already settled. Anything still outstanding is
 * named by `runNeeds` instead, so a line full of counts can't be read as a
 * list of chores — which is exactly how "33 set aside before, 1 read" read.
 */
export function summariseRun(entry: IntakeLogEntry): string {
  if (entry.kind === 'look') {
    const parts: string[] = []
    if (entry.pictures != null && entry.folders != null) {
      // The folder count is the point as much as the picture count: it's what
      // shows the look went through everything below the folder, not just it.
      parts.push(
        `${entry.pictures.toLocaleString()} picture${entry.pictures === 1 ? '' : 's'} in ${entry.folders.toLocaleString()} folder${entry.folders === 1 ? '' : 's'}`
      )
    }
    if (entry.alreadyFiled) parts.push(`${entry.alreadyFiled.toLocaleString()} already filed`)
    if (entry.setAside) {
      parts.push(`${entry.setAside.toLocaleString()} already judged not your work`)
    }
    if (entry.read) parts.push(`${entry.read.toLocaleString()} newly read`)
    parts.push(entry.found ? `${entry.found.toLocaleString()} new to file` : 'nothing new to file')
    return `${entry.stopped ? 'stopped early — ' : ''}${parts.join(', ')}`
  }
  if (entry.kind === 'file') {
    const parts = [`${(entry.filed ?? 0).toLocaleString()} filed`]
    if (entry.removed) parts.push(`${entry.removed.toLocaleString()} taken out of the photos`)
    if (entry.described) parts.push(`${entry.described.toLocaleString()} described`)
    if (entry.failed) parts.push(`${entry.failed.toLocaleString()} failed`)
    return parts.join(', ')
  }
  if (entry.kind === 'folders') {
    const parts = [
      `${(entry.foldersRemoved ?? 0).toLocaleString()} empty folder${entry.foldersRemoved === 1 ? '' : 's'} removed`,
    ]
    if (entry.failed) parts.push(`${entry.failed.toLocaleString()} could not be removed`)
    return parts.join(', ')
  }
  if (entry.kind === 'forget') {
    return `${(entry.forgotten ?? 0).toLocaleString()} decision${entry.forgotten === 1 ? '' : 's'} dropped for pictures no longer in the photo folder`
  }
  const parts = [`${(entry.removed ?? 0).toLocaleString()} already-filed pictures taken out of the photos`]
  if (entry.failed) parts.push(`${entry.failed.toLocaleString()} could not be removed`)
  return parts.join(', ')
}

/**
 * What the run leaves outstanding, if anything — named as an action, with
 * where to do it.
 *
 * A run that leaves nothing outstanding says so. A list of counts with no
 * verdict reads as a chore whose instructions went missing, which is worse
 * than saying "nothing to do".
 */
export type RunFollowUp = {
  /** What's left, in words. */
  what: string
  /** 'look' is the banner's own button; 'setup' is the Filing new artwork
   *  section, which is where a decision can be taken back. */
  where: 'look' | 'setup' | null
}

export function runNeeds(entry: IntakeLogEntry): RunFollowUp | null {
  if (entry.kind !== 'look') return entry.failed ? { what: 'Some files failed — see the error above.', where: null } : null

  // A budgeted run is the one genuine follow-up: there are pictures it hasn't
  // opened yet, and the only thing that opens them is another look.
  if (entry.remaining) {
    return {
      what: `${entry.remaining.toLocaleString()} picture${entry.remaining === 1 ? '' : 's'} still to be read — each look reads up to ${EXAMINE_BUDGET}.`,
      where: 'look',
    }
  }
  if (entry.stopped) {
    return { what: 'This look was stopped before it finished.', where: 'look' }
  }
  // Everything else is settled. The set-aside pile is the one settled thing
  // that can be unsettled, so it's offered as a choice rather than a task.
  if (entry.found === 0 && entry.setAside) {
    return {
      what: 'Nothing to do. Pictures judged not to be your work are never offered again — you can put them back in front of it.',
      where: 'setup',
    }
  }
  return entry.found ? null : { what: 'Nothing to do.', where: null }
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
  opts?: { onProgress?: (examined: number, total: number) => void; signal?: AbortSignal }
): Promise<IntakeScan> {
  const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }
  const sources = intakeSources(config)

  const [walks, dest, examined] = await Promise.all([
    Promise.all(
      sources.map(async (folder) => ({
        folder,
        walk: await walkTree(locOf(folder), folder.path, { signal: opts?.signal }),
      }))
    ),
    walkTree(destLoc, config.dest.path, { signal: opts?.signal }),
    loadExamined(metadataLoc),
  ])

  // Both walks come back partial when they were called off, and a partial
  // listing would name pictures as unfiled that simply weren't reached yet.
  if (opts?.signal?.aborted) {
    return { matches: [], strays: [], remaining: 0, examined: 0, stopped: true, logged: null }
  }

  // Which folder each picture came out of travels with it: the sources can be
  // on different devices, and a copy taken from the wrong one is a copy of
  // whatever happens to share that path there.
  const found = walks.flatMap(({ folder, walk }) => walk.files.map((file) => ({ folder, file })))
  const sourceFolderCount = walks.reduce((n, { walk }) => n + walk.folderRelPaths.length + 1, 0)

  // Already filed, or already judged not to be hers. Content hashes, so a
  // renamed copy is still recognised as the same picture.
  const alreadyThere = new Set(dest.files.map((f) => f.md5))
  // The rejected ones get added to `examined` as the run goes, so the count
  // for the log is taken before that starts — otherwise this run's work would
  // be reported as something earlier runs had already decided.
  const examinedBefore = new Set(examined)
  const candidates = found.filter(
    ({ file }) => !alreadyThere.has(file.md5) && !examined.has(file.md5)
  )

  // No header read needed to know these are hers: the same content is in the
  // artwork folder, which is how it got there. Every earlier run that copied
  // rather than moved left one of these behind, so this is the backlog that
  // stands between "filed" and "separated".
  const strays =
    config.mode === 'move'
      ? found
          .filter(({ file }) => alreadyThere.has(file.md5))
          .map(({ folder, file }) => ({
            md5: file.md5,
            path: file.absPath,
            name: file.absPath.split('/').pop() ?? file.md5,
            device: folder.device,
            mountpoint: folder.mountpoint,
            reason: `Already in ${folderLabel(config.dest)}`,
          }))
      : []

  // A sweep of a whole archive against a budget means pressing the button a
  // hundred times, so the budget can be lifted. It's still interruptible —
  // Skip stops it between files and keeps every header already read.
  const batch = config.lookUntilDone ? candidates : candidates.slice(0, EXAMINE_BUDGET)
  const tools = artTools(config)
  const matches: IntakeMatch[] = []
  let done = 0

  let cursor = 0
  async function worker() {
    for (;;) {
      if (opts?.signal?.aborted) return
      const next: { folder: FolderRef; file: WalkEntry } | undefined = batch[cursor++]
      if (!next) return
      const { folder, file } = next
      let reason: string | null = null
      try {
        reason = artworkReason(await readArtworkMetadata(locOf(folder), file.absPath), tools)
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
          device: folder.device,
          mountpoint: folder.mountpoint,
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

  // Saved even when it was called off: every header read is a request that
  // needn't be made again, so stopping costs nothing already spent.
  await saveExamined(metadataLoc, examined).catch(() => {
    // Losing this costs a repeated scan, never a wrong result.
  })

  // A stopped look is still worth recording — knowing it was called off is
  // the difference between "nothing was found" and "nothing was looked at".
  const entry: IntakeLogEntry = {
    at: new Date().toISOString(),
    kind: 'look',
    // Every source's whole tree, however deep: walkTree queues each subfolder
    // it meets, and each source is walked the same way.
    folders: sourceFolderCount,
    pictures: found.length,
    alreadyFiled: found.filter(({ file }) => alreadyThere.has(file.md5)).length,
    setAside: found.filter(({ file }) => examinedBefore.has(file.md5)).length,
    read: done,
    found: matches.length,
    remaining: candidates.length - batch.length,
    ...(opts?.signal?.aborted ? { stopped: true } : {}),
  }
  await appendIntakeLog(metadataLoc, entry).catch(() => {
    // A missing line in the log is not worth failing a scan over.
  })

  if (opts?.signal?.aborted) {
    return { matches: [], strays: [], remaining: 0, examined: done, stopped: true, logged: entry }
  }

  return {
    matches,
    strays,
    remaining: candidates.length - batch.length,
    examined: batch.length,
    stopped: false,
    logged: entry,
  }
}

export type IntakeResult = {
  copied: number
  failed: { name: string; error: string }[]
  /** Where each copy landed, so the caller can describe them straight away. */
  copiedPaths: string[]
  /** Originals taken out of the photo folder. Zero unless moving. */
  removed: number
  /** Copied, but the original stayed put — reported apart from a failed copy
   *  because the picture is safely filed and only the tidying went wrong. */
  removeFailed: { name: string; error: string }[]
}

// One at a time: a copy is a server-side operation on Jottacloud's side, and
// a burst of them against a folder being written to is how the earlier copy
// work produced half-written trees.
export async function fileIntake(config: IntakeConfig, matches: IntakeMatch[]): Promise<IntakeResult> {
  const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }
  const failed: IntakeResult['failed'] = []
  let copied = 0

  // Names collide across a camera roll — two exports a month apart can share
  // one, and the look goes through every folder under the source, so two
  // pictures that never met can arrive here with the same name. Checked
  // against what's actually in the folder, once, rather than trusting the
  // name to be free.
  const existing = new Set(
    (await listFolder(destLoc, config.dest.path).catch(() => null))?.files.map((f) => f.name) ?? []
  )

  const copiedPaths: string[] = []
  const removeFailed: IntakeResult['removeFailed'] = []
  let removed = 0
  // Where each piece of content landed this run. The photo folder can hold
  // the same picture in several places, and flattening them all into one
  // destination would otherwise put the same image in it twice under two
  // names — the very thing the rest of this app exists to clean up.
  const landedByMd5 = new Map<string, string>()

  for (const match of matches) {
    const already = landedByMd5.get(match.md5)
    if (already) {
      // Nothing to copy: this content is in the destination as of a moment
      // ago. In move mode the spare copy still goes, because filed is filed
      // however many copies of it the photo folder happened to hold.
      if (config.mode === 'move') {
        try {
          await deleteFile(locOf(match), match.path)
          removed++
        } catch (err) {
          removeFailed.push({
            name: match.name,
            error: err instanceof Error ? err.message : 'Could not remove the original.',
          })
        }
      }
      continue
    }

    const name = uniqueName(match.name, existing)
    try {
      // Always straight into the destination folder, never into anything
      // below it: the source's own folders are a phone's filing, not hers,
      // and the point of the artwork folder is that a piece is in it. Joined
      // rather than interpolated because a destination at the root of a
      // mountpoint has an empty path, which would otherwise give "/name".
      const destPath = [config.dest.path, name].filter(Boolean).join('/')
      await copyFile(locOf(match), match.path, destLoc, destPath)
      existing.add(name)
      landedByMd5.set(match.md5, destPath)
      copiedPaths.push(destPath)
      copied++
    } catch (err) {
      failed.push({ name: match.name, error: err instanceof Error ? err.message : 'Copy failed.' })
      continue
    }
    // Strictly after the copy has succeeded, and skipped entirely when it
    // hasn't: a move that removes first, or removes anyway, is a move that
    // can lose the picture.
    if (config.mode === 'move') {
      try {
        await deleteFile(locOf(match), match.path)
        removed++
      } catch (err) {
        removeFailed.push({
          name: match.name,
          error: err instanceof Error ? err.message : 'Could not remove the original.',
        })
      }
    }
  }

  return { copied, failed, copiedPaths, removed, removeFailed }
}

/** A folder named well enough to delete: which mountpoint, and where in it.
 *  With several sources a bare path no longer says where a folder is. */
export type SourceFolder = { device: string; mountpoint: string; path: string }

export type Leftovers = {
  /** Folders with no picture anywhere beneath them, each one the top of an
   *  empty stretch — deleting it takes the empty folders under it too. */
  emptyFolders: SourceFolder[]
  /** Everything empty, including the ones covered by a parent above. Counted
   *  because "9 folders" would badly understate 451 of them going. */
  emptyFoldersTotal: number
  pictures: number
  folders: number
  setAsideTotal: number
  /** Set aside, but no longer in the photo folder at all — decisions about
   *  pictures that have since been moved or deleted. */
  setAsideStale: number
  /** A sample of the empty folders, listed again one by one and reported
   *  raw. "Empty" is this app's word for "the walk found no file with a
   *  checksum beneath it", which is not the same as Jottacloud holding
   *  nothing there — and the difference is the difference between tidying up
   *  and throwing away photographs. */
  samples: EmptyFolderSample[]
  /** Folders that couldn't be listed even after retrying. Every count here
   *  is short by whatever was in them, so nothing may be removed. */
  unreadable: number
}

export type EmptyFolderSample = {
  path: string
  /** Live entries Jottacloud lists in it. */
  entries: number
  /** Live entries with no checksum: files this app's walk cannot see. Any
   *  number here means "empty" is wrong and nothing should be removed. */
  withoutHash: number
  /** Entries Jottacloud is holding as deleted — already in the trash. */
  deleted: number
  subfolders: number
  /** Why it couldn't be looked at, if it couldn't. */
  error?: string
}

/** How many of the empty folders get a closer look. Each one is a request,
 *  and twenty is enough to tell "emptied by moving" from "the walk is blind
 *  to what's in there". */
const SAMPLE_LIMIT = 20

function parentOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/')
  return cut === -1 ? '' : relPath.slice(0, cut)
}

/**
 * What filing has left behind in the photo folder: folders emptied by moving
 * their contents out, and decisions recorded about pictures that are no
 * longer there.
 *
 * One walk answers both, because both are questions about what is in the
 * source folder now as against what used to be.
 */
export async function findLeftovers(
  metadataLoc: MountpointRef,
  config: IntakeConfig,
  opts?: { signal?: AbortSignal }
): Promise<Leftovers> {
  const sources = intakeSources(config)
  // A walk of an archive is tens of thousands of listings; one that stays
  // broken after its retries shouldn't throw away the other thirty thousand.
  // It is counted instead, and counted failures stop anything being removed.
  const unreadable: string[] = []
  const [walks, examined] = await Promise.all([
    Promise.all(
      sources.map(async (folder) => ({
        folder,
        walk: await walkTree(locOf(folder), folder.path, {
          signal: opts?.signal,
          onFolderError: (path) => unreadable.push(path),
        }),
      }))
    ),
    loadExamined(metadataLoc),
  ])

  const empty: SourceFolder[] = []
  const tops: SourceFolder[] = []
  const present = new Set<string>()
  let pictures = 0
  let folderCount = 0

  for (const { folder, walk } of walks) {
    // Every folder on the way up from a picture holds a picture, so far as
    // emptying goes: a folder is only empty when nothing beneath it is a file.
    const holdsPictures = new Set<string>([''])
    for (const file of walk.files) {
      present.add(file.md5)
      let at = parentOf(file.relPath)
      for (;;) {
        if (holdsPictures.has(at)) break
        holdsPictures.add(at)
        if (at === '') break
        at = parentOf(at)
      }
    }

    const fullPath = (rel: string) => [folder.path, rel].filter(Boolean).join('/')
    for (const rel of walk.folderRelPaths) {
      if (holdsPictures.has(rel)) continue
      const entry = { device: folder.device, mountpoint: folder.mountpoint, path: fullPath(rel) }
      empty.push(entry)
      // Only the top of each empty stretch: deleting a folder takes what's
      // under it, so listing the children as well would be asking for the
      // same work twice and, worse, after it's already been done.
      if (holdsPictures.has(parentOf(rel))) tops.push(entry)
    }

    pictures += walk.files.length
    folderCount += walk.folderRelPaths.length + 1
  }

  let stale = 0
  for (const md5 of examined) if (!present.has(md5)) stale++

  // Asked again, one at a time, and reported exactly as Jottacloud answers.
  // The walk keeps only files it has a checksum for, so a folder full of
  // pictures it can't read a checksum from looks empty to it — the one
  // mistake in here that would cost photographs rather than tidy them.
  const samples: EmptyFolderSample[] = []
  for (const folder of empty.slice(0, SAMPLE_LIMIT)) {
    try {
      const listing = await listFolder(locOf(folder), folder.path, { includeDeleted: true })
      const live = listing.files.filter((f) => !f.deleted)
      samples.push({
        path: `${folder.mountpoint}/${folder.path}`,
        entries: live.length,
        withoutHash: live.filter((f) => !f.md5).length,
        deleted: listing.files.length - live.length,
        subfolders: listing.folders.filter((f) => !f.deleted).length,
      })
    } catch (err) {
      samples.push({
        path: `${folder.mountpoint}/${folder.path}`,
        entries: 0,
        withoutHash: 0,
        deleted: 0,
        subfolders: 0,
        error: err instanceof Error ? err.message : 'Could not list it.',
      })
    }
  }

  return {
    emptyFolders: tops,
    emptyFoldersTotal: empty.length,
    pictures,
    folders: folderCount,
    setAsideTotal: examined.size,
    setAsideStale: stale,
    samples,
    unreadable: unreadable.length,
  }
}

/** Removes the folders `findLeftovers` found empty. They go to the trash. */
export async function removeEmptyFolders(
  config: IntakeConfig,
  folders: SourceFolder[],
  opts?: { onProgress?: (done: number, total: number) => void }
): Promise<{ removed: number; failed: { name: string; error: string }[] }> {
  const failed: { name: string; error: string }[] = []
  let removed = 0
  let done = 0

  for (const folder of folders) {
    try {
      await deleteFolder(locOf(folder), folder.path)
      removed++
    } catch (err) {
      failed.push({
        name: `${folder.mountpoint}/${folder.path}`,
        error: err instanceof Error ? err.message : 'Could not remove the folder.',
      })
    }
    opts?.onProgress?.(++done, folders.length)
  }

  return { removed, failed }
}

/**
 * Drops from the set-aside list every picture no longer in the photo folder,
 * so the count means "pictures in there I've decided about" rather than a
 * running total since the beginning.
 *
 * Losing a decision costs one header read if that content ever comes back.
 */
export async function pruneSetAside(
  metadataLoc: MountpointRef,
  config: IntakeConfig
): Promise<{ kept: number; forgotten: number }> {
  const [walks, examined] = await Promise.all([
    Promise.all(intakeSources(config).map((folder) => walkTree(locOf(folder), folder.path))),
    loadExamined(metadataLoc),
  ])

  // Present anywhere it looks, not just in the first place: a decision is
  // only stale when the picture is in none of them.
  const present = new Set(walks.flatMap((walk) => walk.files.map((f) => f.md5)))
  const kept = new Set([...examined].filter((md5) => present.has(md5)))
  await saveExamined(metadataLoc, kept)
  return { kept: kept.size, forgotten: examined.size - kept.size }
}

/**
 * Takes out of the photo folder the pictures whose content is already in the
 * artwork folder — the ones earlier copying left behind.
 *
 * The destination is walked again first, so nothing is removed on the strength
 * of a listing taken minutes ago: a picture is only taken out of the source
 * once its content has been seen in the destination just now.
 */
export async function removeStrays(
  config: IntakeConfig,
  strays: IntakeMatch[],
  opts?: { onProgress?: (done: number, total: number) => void }
): Promise<{ removed: number; failed: { name: string; error: string }[]; unconfirmed: number }> {
  const destLoc = { device: config.dest.device, mountpoint: config.dest.mountpoint }

  const dest = await walkTree(destLoc, config.dest.path)
  const filed = new Set(dest.files.map((f) => f.md5))

  const failed: { name: string; error: string }[] = []
  let removed = 0
  let unconfirmed = 0
  let done = 0

  for (const stray of strays) {
    if (!filed.has(stray.md5)) {
      unconfirmed++
      opts?.onProgress?.(++done, strays.length)
      continue
    }
    try {
      await deleteFile(locOf(stray), stray.path)
      removed++
    } catch (err) {
      failed.push({
        name: stray.name,
        error: err instanceof Error ? err.message : 'Could not remove it.',
      })
    }
    opts?.onProgress?.(++done, strays.length)
  }

  return { removed, failed, unconfirmed }
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
