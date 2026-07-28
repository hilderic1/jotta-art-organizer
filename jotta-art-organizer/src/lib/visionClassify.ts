// Calls the /api/files/classify route (server-side Anthropic vision call)
// to get a closed-list judgment of an artwork's style/subject/palette/
// framing/mood — unlike the metadata-derived tags, this actually looks at
// the image, so it's the only source for these categories, at real
// per-image cost (a paid third-party API, unlike everything else in this
// app).
import type { MountpointRef } from '@/lib/api'

export const STYLE_CATEGORY_ID = 'style'
export const SUBJECT_CATEGORY_ID = 'subject'
export const PALETTE_CATEGORY_ID = 'palette'
export const FRAMED_CATEGORY_ID = 'framed'
export const MOOD_CATEGORY_ID = 'mood'
// Deliberately open, unlike the five above: this is where the model can name
// a style the closed list is missing, for review and possible promotion into
// STYLE_DEFINITIONS. Kept separate so speculative words never contaminate
// Style itself, which Browse-by-tag depends on being a stable vocabulary.
export const SUGGESTED_STYLE_CATEGORY_ID = 'suggestedStyle'

// Single source of truth for the closed lists — the API route uses these
// to constrain the model's tool call, and the tag editor uses the same
// lists to show the full picker for a category even before it's ever been
// saved (these categories start empty otherwise, which meant the modal had
// nothing to render for a value the AI had just assigned).
// This library is overwhelmingly abstract, intuitive digital art made in
// PicsArt, so the style vocabulary is the one that actually describes that
// work. The definitions travel with the values: they're what the model is
// given to choose against, and a bare label like "Conceptual Digital Art"
// is far too open to interpretation on its own.
export const STYLE_DEFINITIONS: Record<string, string> = {
  'Abstract Digital Art': 'built on colour, form, rhythm and composition rather than realistic subjects',
  'Intuitive Digital Art': 'made without a predetermined plan, with instinct and emotion guiding the process',
  'Generative Art': 'produced partly or entirely by algorithms or code',
  'Digital Expressionism': 'emphasises emotion, energy and personal experience over realism',
  'Surreal Digital Art': 'dreamlike, symbolic, or impossible worlds',
  'Geometric/Constructivist Digital Art': 'built around mathematical or architectural structure',
  'Mixed-Media Digital Art': 'combines painting, photography, drawing, texture and digital technique',
  'Conceptual Digital Art': 'the underlying idea matters as much as the visual result',
  'Visionary/Cosmic Art': 'explores space, consciousness, spirituality, or the universe',
  Other: 'genuinely none of the above — e.g. a photograph or a non-artwork image',
}

export const STYLE_VALUES = Object.keys(STYLE_DEFINITIONS)
export const SUBJECT_VALUES = ['Portrait/Figure', 'Animal', 'Abstract', 'Nature/Floral', 'Cosmic/Sci-fi', 'Other']
export const PALETTE_VALUES = ['Warm', 'Cool', 'Vibrant/Mixed', 'Monochrome']
export const FRAMED_VALUES = ['Yes', 'No']
export const MOOD_VALUES = ['Calm/Serene', 'Energetic/Vibrant', 'Dreamy/Mystical', 'Somber/Intense', 'Dark/Moody', 'Ornamental/Decorative']

export const KNOWN_CLASSIFICATION_VALUES: Record<string, string[]> = {
  [STYLE_CATEGORY_ID]: STYLE_VALUES,
  [SUBJECT_CATEGORY_ID]: SUBJECT_VALUES,
  [PALETTE_CATEGORY_ID]: PALETTE_VALUES,
  [FRAMED_CATEGORY_ID]: FRAMED_VALUES,
  [MOOD_CATEGORY_ID]: MOOD_VALUES,
}

export type ArtworkClassification = {
  // Style and mood overlap by nature — a piece is readily intuitive *and*
  // expressionist *and* cosmic, and calm *and* dreamlike — so both carry
  // every value that applies instead of forcing a single winner and
  // discarding the rest.
  style: string[]
  subject: string
  palette: string
  framed: string
  mood: string[]
  /** Free text, absent unless the model judged the closed list insufficient. */
  suggestedStyle?: string
}

// The model is asked for an array, but a single string is the obvious way
// for it to go wrong, and a stored tag list of split characters would be a
// mess to clean up. Cheap to be forgiving here.
function valueList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.filter((s) => typeof s === 'string' && s.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

export async function classifyArtwork(loc: MountpointRef, path: string): Promise<ArtworkClassification> {
  const res = await fetch('/api/files/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: loc.device, mountpoint: loc.mountpoint, path }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Classification failed (${res.status}).`)
  return { ...data, style: valueList(data.style), mood: valueList(data.mood) } as ArtworkClassification
}

// Overwrites rather than accumulates: each of these five is a single
// current judgment (like a rating), not a growing history of everything
// ever observed — re-classifying replaces the previous guess instead of
// piling values up the way People/Year do.
export function tagsFromClassification(
  c: ArtworkClassification,
  existing: Record<string, string[]> = {}
): Record<string, string[]> {
  const suggestion = c.suggestedStyle?.trim()
  return {
    ...existing,
    [STYLE_CATEGORY_ID]: valueList(c.style),
    [SUBJECT_CATEGORY_ID]: [c.subject],
    [PALETTE_CATEGORY_ID]: [c.palette],
    [FRAMED_CATEGORY_ID]: [c.framed],
    [MOOD_CATEGORY_ID]: valueList(c.mood),
    // Always written, empty when there's nothing to suggest, so that
    // re-classifying clears a previous suggestion instead of leaving a
    // stale one attached to a piece that no longer warrants it.
    [SUGGESTED_STYLE_CATEGORY_ID]: suggestion ? [suggestion] : [],
  }
}

// Used by the batch classifier to skip files that already have a full set
// of AI-derived tags, so re-running a batch doesn't re-spend API calls on
// content that's already been classified.
export function isFullyClassified(tags: Record<string, string[]> | undefined): boolean {
  if (!tags) return false
  return (
    (tags[STYLE_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[SUBJECT_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[PALETTE_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[FRAMED_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[MOOD_CATEGORY_ID]?.length ?? 0) > 0
  )
}
