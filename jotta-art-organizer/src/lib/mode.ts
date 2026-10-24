// Which job the app is set up for.
//
// The app grew to cover two jobs — keeping a photo library in order, and
// cataloguing an artist's own work — plus the one-off repairs and surveys
// that sorting out a twenty-year library needed. All of it at once, on every
// screen, for anyone opening it to title a picture.
//
// So it has a mode. Photos and PicsArt each hide what belongs to the other
// job and the instruments belonging to neither, and start in the folder that
// job lives in. General is everything, which is what it has always been.
//
// Stored with the catalogue rather than on the device: the same person works
// from an iPad, a phone and a laptop, and a mode that only applied to
// whichever machine set it would be a setting that disagrees with itself.
import type { MountpointRef } from '@/lib/api'
import { readJsonFile, writeJsonFile } from '@/lib/jsonStore'

const MODE_FOLDER = '.jotta-art-organizer'
const MODE_FILENAME = 'mode.json'

export type AppMode = 'general' | 'photos' | 'artwork'

/** Which job a characteristic belongs to. Absent means both. */
export type CategoryScope = 'photos' | 'artwork' | 'both'

export type FolderRef = MountpointRef & { path: string }

export type ModeConfig = {
  mode: AppMode
  /** Where each job's pictures live, so a mode opens there instead of asking.
   *  Absent means it hasn't been set and the folder is still chosen by hand. */
  folders?: Partial<Record<Exclude<AppMode, 'general'>, FolderRef>>
  /** Per category, overriding the proposal below. Hers to decide: which
   *  characteristics belong to photographs and which to her work is not
   *  something this app can know. */
  categoryScopes?: Record<string, CategoryScope>
}

export const MODE_NAMES: Record<AppMode, string> = {
  general: 'General',
  photos: 'Photos',
  artwork: 'PicsArt',
}

export const MODE_DESCRIPTIONS: Record<AppMode, string> = {
  general: 'Everything, including the one-off repairs and the instruments for looking into the account.',
  photos: 'Photographs only. Starts in the photo folder, and leaves out what only applies to her own work.',
  artwork: 'Her own work only. Starts in the artwork folder, and leaves out what only applies to photographs.',
}

/**
 * The proposed split, which the setting overrides per category.
 *
 * Artwork: what a piece is and how it was made — nothing a photograph has.
 * Photos: who is in it, where it was taken, whether it was a favourite —
 * nothing a drawing has.
 *
 * Everything not named here counts as both, which is deliberately where
 * dates and anything she adds herself end up: a date belongs to both jobs,
 * and a category this app has never heard of is not one it should hide.
 */
export const PROPOSED_SCOPES: Record<string, CategoryScope> = {
  // Her own work.
  style: 'artwork',
  subject: 'artwork',
  framed: 'artwork',
  figures: 'artwork',
  editorCreated: 'artwork',
  drawTime: 'artwork',
  photoUsed: 'artwork',
  programName: 'artwork',
  sourceType: 'artwork',
  credit: 'artwork',
  derivedFrom: 'artwork',
  // Photographs.
  people: 'photos',
  favorited: 'photos',
  geoData: 'photos',
  source: 'photos',
}

export function scopeOf(categoryId: string, config: ModeConfig | null): CategoryScope {
  return config?.categoryScopes?.[categoryId] ?? PROPOSED_SCOPES[categoryId] ?? 'both'
}

/** Whether a category is worth showing in the mode in force. */
export function shownInMode(categoryId: string, config: ModeConfig | null): boolean {
  const mode = config?.mode ?? 'general'
  if (mode === 'general') return true
  const scope = scopeOf(categoryId, config)
  return scope === 'both' || scope === mode
}

/** The folder this mode works in, if one has been set. */
export function folderForMode(config: ModeConfig | null): FolderRef | null {
  const mode = config?.mode ?? 'general'
  if (mode === 'general') return null
  return config?.folders?.[mode] ?? null
}

/**
 * Whether the instruments belong on screen: the surveys, the one-off
 * repairs, the duplicate finder, the export check.
 *
 * None of it is part of using the app, and all of it was on screen at once.
 * Still reachable by address in any mode — hidden, not removed, because a
 * mode is about what is in the way rather than about what is allowed.
 */
export function toolsVisible(config: ModeConfig | null): boolean {
  return (config?.mode ?? 'general') === 'general'
}

export async function loadModeConfig(metadataLoc: MountpointRef): Promise<ModeConfig> {
  const stored = await readJsonFile<ModeConfig>(metadataLoc, `${MODE_FOLDER}/${MODE_FILENAME}`)
  return stored?.mode ? stored : { mode: 'general' }
}

export async function saveModeConfig(
  metadataLoc: MountpointRef,
  config: ModeConfig
): Promise<void> {
  await writeJsonFile(metadataLoc, MODE_FOLDER, MODE_FILENAME, config)
}
