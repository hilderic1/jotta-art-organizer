// One answer to "which folder does this mode work in?", for every screen.
//
// Sits apart from mode.ts so that module stays free of the filing config:
// PicsArt's fallback is the folder filing puts her work in, and reaching for
// it from mode.ts would tie the mode to the intake and back again.
import type { MountpointRef } from '@/lib/api'
import { loadIntakeConfig } from '@/lib/photoIntake'
import { resolveModeFolder, type FolderRef, type ModeConfig } from '@/lib/mode'

export async function modeFolder(
  metadataLoc: MountpointRef
): Promise<{ config: ModeConfig; folder: FolderRef | null }> {
  return resolveModeFolder(metadataLoc, async () => {
    const intake = await loadIntakeConfig(metadataLoc)
    return intake?.dest ?? null
  })
}
