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
      mood: { type: 'string', enum: MOOD_VALUES, description: 'The overall emotional tone/mood.' },
    },
    required: ['style', 'subject', 'palette', 'framed', 'mood'],
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
                  'Classify this artwork using the classify_artwork tool. Context: this collection is ' +
                  'largely abstract, intuitive digital art created in PicsArt, so judge it on colour, form, ' +
                  'rhythm, texture and composition rather than looking for a realistic subject. Absence of a ' +
                  'recognisable subject is normal here and is not a reason to answer "Other".',
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
    const raw = Array.isArray(input.style) ? input.style : [input.style]
    let style = [...new Set(raw.filter((s): s is string => typeof s === 'string' && STYLE_VALUES.includes(s)))].slice(
      0,
      3
    )
    // "Other" means nothing else fit, so it can't sit beside a real style.
    if (style.length > 1) style = style.filter((s) => s !== 'Other')
    if (style.length === 0) style = ['Other']

    return NextResponse.json({ ...input, style })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
