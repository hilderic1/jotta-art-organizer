// Calls the /api/files/classify route (server-side Anthropic vision call)
// to get a closed-list judgment of an artwork's style, subject, framing and
// the forms visible in it — unlike the metadata-derived tags, this actually looks at
// the image, so it's the only source for these categories, at real
// per-image cost (a paid third-party API, unlike everything else in this
// app).
import type { MountpointRef } from '@/lib/api'

export const STYLE_CATEGORY_ID = 'style'
export const SUBJECT_CATEGORY_ID = 'subject'
export const FRAMED_CATEGORY_ID = 'framed'
// Open, like the suggestions: the whole point is naming what's actually
// there, and no fixed list could anticipate it.
export const FIGURES_CATEGORY_ID = 'figures'

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
// Labels are deliberately one word where possible. Every style here is
// digital art, so spelling that out in each name buried the distinguishing
// word at the end of a mouthful and made three of them unreadable on one
// piece. The definitions carry the full meaning, and they're what the model
// classifies against, so the short labels cost nothing in accuracy.
export const STYLE_DEFINITIONS: Record<string, string> = {
  Abstract: 'built on colour, form, rhythm and composition rather than realistic subjects',
  Intuitive:
    'made without a predetermined plan — evident as gestural, spontaneous mark-making rather than deliberate construction',
  Generative:
    'produced partly or entirely by algorithms or code — evident as systematic repetition, fractal or mathematical patterning',
  Expressionist: 'emphasises emotion, energy and personal experience over realism',
  Surreal: 'dreamlike, symbolic, or impossible worlds',
  Geometric:
    'composed from geometric shapes — triangles, planes, circles, hard-edged forms — whether or not the underlying structure is mathematical or architectural',
  'Mixed-Media': 'combines painting, photography, drawing, texture and digital technique',
  Conceptual:
    'the underlying idea matters as much as the visual result — evident as deliberate symbolic, textual or referential content',
  'Visionary/Cosmic': 'explores space, consciousness, spirituality, or the universe',
  Figurative: 'recognisable subjects rendered representationally — studies, portraits, still life, landscape',
  Other: 'genuinely none of the above — e.g. a photograph or a non-artwork image',
}

// How many values each category may hold. The classifier is held to these by
// its schema; the editor enforces the same limits so a hand edit can't drift
// past what the vocabulary is designed for.
export const CATEGORY_VALUE_LIMITS: Record<string, number> = {
  [STYLE_CATEGORY_ID]: 3,
  [SUBJECT_CATEGORY_ID]: 1,
  [FRAMED_CATEGORY_ID]: 1,
  [FIGURES_CATEGORY_ID]: 4,
  // One original per enhanced piece — picking another replaces it.
  derivedFrom: 1,
}

export const STYLE_VALUES = Object.keys(STYLE_DEFINITIONS)

// These three describe how a piece was made rather than how it looks, and no
// image can settle them — only the artist knows whether a work was planned.
// Left unqualified they attach to almost anything, crowding out the styles
// that are actually visible, so the classifier is told to require evidence.
export const PROCESS_STYLES = ['Intuitive', 'Conceptual', 'Generative']
export const SUBJECT_VALUES = ['Portrait/Figure', 'Animal', 'Abstract', 'Nature/Floral', 'Cosmic/Sci-fi', 'Other']
export const FRAMED_VALUES = ['Yes', 'No']

export const KNOWN_CLASSIFICATION_VALUES: Record<string, string[]> = {
  [STYLE_CATEGORY_ID]: STYLE_VALUES,
  [SUBJECT_CATEGORY_ID]: SUBJECT_VALUES,
  [FRAMED_CATEGORY_ID]: FRAMED_VALUES,
}

export type ArtworkClassification = {
  /** What the model says it sees, written before it labels anything. Shown
   *  in the editor so a wrong classification can be traced to a misreading
   *  of the image rather than guessed at. Not stored as a tag. */
  observation?: string
  // Styles overlap by nature — a piece is readily geometric *and* figurative
  // — so style carries every one that applies instead of forcing a single
  // winner and discarding the rest.
  style: string[]
  subject: string
  framed: string
  /** Forms discernible within the work — often emergent rather than drawn. */
  figures?: string[]
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
  return { ...data, style: valueList(data.style) } as ArtworkClassification
}

// Overwrites rather than accumulates: each of these is a single current
// judgment (like a rating), not a growing history of everything ever
// observed — re-classifying replaces the previous guess instead of piling
// values up the way People/Year do.
export function tagsFromClassification(
  c: ArtworkClassification,
  existing: Record<string, string[]> = {}
): Record<string, string[]> {
  return {
    ...existing,
    [STYLE_CATEGORY_ID]: valueList(c.style),
    [SUBJECT_CATEGORY_ID]: [c.subject],
    [FRAMED_CATEGORY_ID]: [c.framed],
    [FIGURES_CATEGORY_ID]: valueList(c.figures),
  }
}

// Used by the batch classifier to skip files that already have a full set
// of AI-derived tags, so re-running a batch doesn't re-spend API calls on
// content that's already been classified.
export function isFullyClassified(tags: Record<string, string[]> | undefined): boolean {
  if (!tags) return false
  // Figures isn't required: it's legitimately empty on plenty of work, and
  // demanding it would re-classify the same files forever.
  return (
    (tags[STYLE_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[SUBJECT_CATEGORY_ID]?.length ?? 0) > 0 &&
    (tags[FRAMED_CATEGORY_ID]?.length ?? 0) > 0
  )
}
