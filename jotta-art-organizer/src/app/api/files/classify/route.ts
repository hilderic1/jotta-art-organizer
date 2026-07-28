import { NextRequest, NextResponse } from 'next/server'
import { requireAccessToken } from '@/lib/jotta/server'
import { renderImage } from '@/lib/jotta/render'
import { STYLE_VALUES, SUBJECT_VALUES, PALETTE_VALUES, FRAMED_VALUES, MOOD_VALUES } from '@/lib/visionClassify'

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

const CLASSIFY_TOOL = {
  name: 'classify_artwork',
  description: 'Classify the visual style, subject, color palette, framing, and mood of an artwork image.',
  input_schema: {
    type: 'object',
    properties: {
      style: { type: 'string', enum: STYLE_VALUES, description: 'The dominant visual style/technique.' },
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
              { type: 'text', text: 'Classify this artwork image using the classify_artwork tool.' },
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

    return NextResponse.json(toolUse.input)
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not connected to Jottacloud yet.' }, { status: 401 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
