import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { renderImage } from '@/lib/jotta/render'
import {
  STYLE_VALUES,
  STYLE_DEFINITIONS,
  SUBJECT_VALUES,
  PALETTE_VALUES,
  FRAMED_VALUES,
  MOOD_VALUES,
  MOTION_VALUES,
  MOTION_DEFINITIONS,
} from '@/lib/visionClassify'

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

const CLASSIFY_TOOL = {
  name: 'classify_artwork',
  description: 'Classify the visual style, subject, color palette, framing, and mood of an artwork image.',
  input_schema: {
    type: 'object',
    properties: {
      style: {
        type: 'array',
        items: { type: 'string', enum: STYLE_VALUES },
        minItems: 1,
        maxItems: 3,
        description: `Every style that genuinely applies, most characteristic first — these overlap by nature, so one piece is commonly two or three of them. Include a style only if it is actually evident; three weak matches are worse than one accurate one. Use "Other" alone, never alongside another value, and only if none of the rest fit. Definitions — ${Object.entries(
          STYLE_DEFINITIONS
        )
          .map(([value, meaning]) => `${value}: ${meaning}`)
          .join('; ')}.`,
      },
      subject: { type: 'string', enum: SUBJECT_VALUES, description: 'What the image is mainly of.' },
      palette: { type: 'string', enum: PALETTE_VALUES, description: 'The dominant color temperature/palette.' },
      framed: { type: 'string', enum: FRAMED_VALUES, description: 'Whether a decorative border/mat/frame is baked into the image itself.' },
      mood: {
        type: 'array',
        items: { type: 'string', enum: MOOD_VALUES },
        minItems: 1,
        maxItems: 2,
        description:
          'The emotional tone, strongest first. A second may be added where the piece genuinely holds two at once (calm and dreamlike, say), but most work reads as one — do not add a second to fill the slot.',
      },
      motion: {
        type: 'string',
        enum: MOTION_VALUES,
        description: `The sense of movement the piece conveys, which is often what it is reaching for. Judge the movement the image evokes, not literal depicted action. Definitions — ${Object.entries(
          MOTION_DEFINITIONS
        )
          .map(([value, meaning]) => `${value}: ${meaning}`)
          .join('; ')}.`,
      },
      figures: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 4,
        description:
          'Forms discernible within the work, named in one or two words each — "bird", "face in profile", "dancer", "horse". These are frequently emergent rather than deliberately drawn: shapes that resolve out of colour and texture. Name one only where the form genuinely reads as that thing to an attentive viewer; return an empty array when nothing does, and do not manufacture figures out of incidental texture.',
      },
      suggestedStyle: {
        type: 'string',
        description:
          'A style that genuinely describes this piece but is missing from the list, in two or three words — otherwise an empty string. Answer every time: an empty string is the expected answer and means the listed styles cover it. Do not restate a style already offered.',
      },
    },
    required: ['style', 'subject', 'palette', 'framed', 'mood', 'motion', 'figures', 'suggestedStyle'],
  },
}

function normalizeMediaType(contentType: string | null): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  if (contentType?.includes('png')) return 'image/png'
  if (contentType?.includes('gif')) return 'image/gif'
  if (contentType?.includes('webp')) return 'image/webp'
  return 'image/jpeg'
}

export async function POST(request: NextRequest) {
  try {
    const { accessToken, username } = await requireAccessToken()

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY env var is not set. Add it to .env.local (and your Vercel project) to enable AI classification.' },
        { status: 500 }
      )
    }

    const body = (await request.json()) as { device?: string; mountpoint?: string; path?: string }
    if (!body.device || !body.mountpoint || !body.path) {
      return NextResponse.json({ error: 'device, mountpoint, and path are required.' }, { status: 400 })
    }
    const pathSegments = body.path.split('/').filter(Boolean)

    // This used to send Jottacloud's thumbnail, which is 30x30 no matter what
    // size is asked for — far too small to judge style, subject or framing
    // from, so every classification was made on a 30-pixel image. Render from
    // the original instead: 768px is enough detail for these judgments while
    // still costing a fraction of the full-resolution file in tokens.
    const rendered = await renderImage(accessToken, username, body.device, body.mountpoint, pathSegments, 768)
    if (!rendered) {
      return NextResponse.json({ error: 'Failed to fetch image for classification.' }, { status: 502 })
    }
    const mediaType = normalizeMediaType(rendered.contentType)
    const base64 = rendered.body.toString('base64')

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'classify_artwork' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text:
                  'Classify this artwork using the classify_artwork tool. Background, not instruction: the ' +
                  'collection leans towards abstract, intuitive digital art made in PicsArt, so a piece with no ' +
                  'recognisable subject is unremarkable here and is not by itself a reason to answer "Other". ' +
                  'It also holds figurative work — drawings, studies and photographs of people, objects and ' +
                  'places. Classify what is actually in front of you: where a subject is recognisable, name it, ' +
                  'and never call a figurative piece abstract on account of the company it keeps.',
              },
            ],
          },
        ],
      }),
    })

    if (anthropicRes.status === 429) {
      return NextResponse.json({ error: 'Rate limited by the Anthropic API — try again shortly.' }, { status: 429 })
    }
    if (!anthropicRes.ok) {
      const text = await anthropicRes.text().catch(() => '')
      return NextResponse.json(
        { error: `Classification request failed (${anthropicRes.status}): ${text.slice(0, 300)}` },
        { status: 502 }
      )
    }

    const data = (await anthropicRes.json()) as {
      content: { type: string; input?: unknown }[]
    }
    const toolUse = data.content?.find((c) => c.type === 'tool_use')
    if (!toolUse || !toolUse.input) {
      return NextResponse.json({ error: 'No classification returned.' }, { status: 502 })
    }

    // The enum is a constraint on the model, not a guarantee, and these
    // values become stored tags — so drop anything unrecognised rather than
    // letting an invented style into the library.
    const input = toolUse.input as Record<string, unknown>

    const pick = (value: unknown, allowed: string[], max: number): string[] => {
      const raw = Array.isArray(value) ? value : [value]
      return [...new Set(raw.filter((v): v is string => typeof v === 'string' && allowed.includes(v)))].slice(0, max)
    }

    let style = pick(input.style, STYLE_VALUES, 3)
    // "Other" means nothing else fit, so it can't sit beside a real style.
    if (style.length > 1) style = style.filter((s) => s !== 'Other')
    if (style.length === 0) style = ['Other']

    const mood = pick(input.mood, MOOD_VALUES, 2)
    const motion = pick(input.motion, MOTION_VALUES, 1)[0] ?? 'Still'

    // Figures are free text by design, so they get the same treatment as a
    // suggestion: trimmed, length-capped, deduplicated, and dropped when
    // empty. No enum to validate against — naming what's actually there is
    // the entire point.
    const figures = [
      ...new Set(
        (Array.isArray(input.figures) ? input.figures : [])
          .filter((f): f is string => typeof f === 'string')
          .map((f) => f.trim().slice(0, 30))
          .filter((f) => f.length >= 2)
      ),
    ].slice(0, 4)

    // A suggestion is free text, so it gets the tightest handling of all:
    // trimmed, length-capped, and dropped if it just restates a style we
    // already offer — otherwise "Abstract digital art" would arrive as a
    // near-duplicate of the real value and defeat the point of reviewing.
    const proposed = typeof input.suggestedStyle === 'string' ? input.suggestedStyle.trim().slice(0, 40) : ''
    const isRestatement = STYLE_VALUES.some((v) => v.toLowerCase() === proposed.toLowerCase())
    const suggestedStyle = proposed.length >= 3 && !isRestatement ? proposed : undefined

    return NextResponse.json({ ...input, style, mood, motion, figures, suggestedStyle })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
