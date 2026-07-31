'use client'

import { formatExposure, type ArtworkFileMetadata } from '@/lib/imageMetadata'

function isoDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

// Grey means "shown here only, never tagged" — size, resolution, camera and
// the exposure settings are facts about one file, so as tags they'd produce a
// value per picture. The dates in grey are the fallbacks: tagged only when a
// file has nothing better, which is why they're not promised in full colour.
const SHOWN_ONLY = 'text-zinc-500 dark:text-zinc-500'

// What a file says about itself, read-only. Extracted because three places
// want it — the tag editor, the picture viewer in Browse, and Inspect — and
// three copies of this list would drift the moment one gained a field.
export function FileProperties({ meta, className = '' }: { meta: ArtworkFileMetadata; className?: string }) {
  const exposure = formatExposure(meta)
  const anyShownOnly =
    (meta.width != null && meta.height != null) ||
    meta.xResolution != null ||
    meta.camera != null ||
    exposure !== '' ||
    (meta.authors != null && meta.authors.length > 0)

  return (
    <div className={`text-xs ${className}`}>
      {meta.width != null && meta.height != null && (
        <p className={SHOWN_ONLY}>
          📐 {meta.width} × {meta.height}
        </p>
      )}
      {(meta.xResolution != null || meta.yResolution != null) && (
        <p className={SHOWN_ONLY}>
          🔍 {meta.xResolution ?? '?'} × {meta.yResolution ?? '?'} DPI
        </p>
      )}
      {meta.dateTakenAtEpochSeconds != null && <p>📅 Taken: {isoDay(meta.dateTakenAtEpochSeconds)}</p>}
      {meta.dateAcquiredAtEpochSeconds != null && (
        <p className={SHOWN_ONLY}>📥 Acquired: {isoDay(meta.dateAcquiredAtEpochSeconds)}</p>
      )}
      {meta.camera && (
        <p className={SHOWN_ONLY}>
          📷 {meta.camera}
          {meta.lens && meta.lens !== meta.camera && <span> · {meta.lens}</span>}
        </p>
      )}
      {exposure && <p className={SHOWN_ONLY}>⚙️ {exposure}</p>}
      {meta.latitude != null && meta.longitude != null && (
        <p>
          📍 {meta.latitude.toFixed(4)}, {meta.longitude.toFixed(4)}
        </p>
      )}
      {meta.sourceType && (
        <p className="font-medium text-indigo-700 dark:text-indigo-400">
          🔏 Content credentials: {meta.sourceType}
          {meta.credit && ` — ${meta.credit}`}
        </p>
      )}
      {!meta.sourceType && meta.credit && <p>🏷️ Credit: {meta.credit}</p>}

      {/* How the piece was worked on, from the editor's own record. The time
          is tagged as a band; the strokes and brushes beside it are not. */}
      {meta.editorDrawTimeMs != null && meta.editorDrawTimeMs > 0 && (
        <p>
          ✍️ Drawing time:{' '}
          {meta.editorDrawTimeMs < 60000
            ? `${Math.round(meta.editorDrawTimeMs / 1000)} sec`
            : `${Math.round(meta.editorDrawTimeMs / 60000)} min`}
          <span className={SHOWN_ONLY}>
            {meta.editorDrawActions != null && ` · ${meta.editorDrawActions} strokes`}
            {meta.editorBrushesUsed != null && ` · ${meta.editorBrushesUsed} brushes`}
            {meta.editorLayersUsed != null && ` · ${meta.editorLayersUsed} layers`}
          </span>
        </p>
      )}
      {meta.editorPhotosAdded != null && (
        <p>
          🖼️{' '}
          {meta.editorPhotosAdded > 0
            ? `Includes ${meta.editorPhotosAdded} photo(s)`
            : 'Fully drawn — no photo used'}
        </p>
      )}
      {meta.editorCanvasWidth != null &&
        meta.editorCanvasHeight != null &&
        meta.width != null &&
        meta.editorCanvasWidth !== meta.width && (
          <p className={SHOWN_ONLY}>
            ⤢ Drawn at {meta.editorCanvasWidth} × {meta.editorCanvasHeight}, exported at {meta.width} × {meta.height}
          </p>
        )}
      {meta.editorCreatedAtEpochSeconds != null && (
        <p>🎨 Created in editor: {isoDay(meta.editorCreatedAtEpochSeconds)}</p>
      )}
      {meta.fileChangedAtEpochSeconds != null && <p>✏️ Changed: {isoDay(meta.fileChangedAtEpochSeconds)}</p>}
      {meta.jottaCreatedAtEpochSeconds != null && (
        <p className={SHOWN_ONLY}>☁️ Added to Jottacloud: {isoDay(meta.jottaCreatedAtEpochSeconds)}</p>
      )}
      {meta.authors && meta.authors.length > 0 && <p className={SHOWN_ONLY}>🖋️ {meta.authors.join(', ')}</p>}
      {meta.programName && <p>💻 Program: {meta.programName}</p>}
      {meta.copyright && <p>© {meta.copyright}</p>}

      {anyShownOnly && (
        <p className="mt-1 text-[11px] text-zinc-400">Greyed lines are shown here only — they aren&rsquo;t tags.</p>
      )}
    </div>
  )
}
