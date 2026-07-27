import { cookies } from 'next/headers'
import crypto from 'crypto'

const COOKIE_NAME = 'jotta_session'
const ALGO = 'aes-256-gcm'

export type SessionData = {
  username: string
  refreshToken: string
  accessToken: string
  // Epoch ms. Cached so we only hit Jottacloud's token endpoint when it's
  // actually about to expire, not on every request — refresh tokens rotate
  // on each use, so refreshing needlessly often multiplies the odds of two
  // concurrent requests racing on the same (already-consumed) refresh token
  // and Jottacloud's reuse-detection nuking the whole session.
  accessTokenExpiresAt: number
  // Where the tag-metadata JSON file lives. Chosen once by the user (first
  // visit to /tags); unset until then.
  metadataLocation?: { device: string; mountpoint: string }
}

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error(
      'SESSION_SECRET env var is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    )
  }
  const key = Buffer.from(secret, 'base64')
  if (key.length !== 32) {
    throw new Error('SESSION_SECRET must decode to exactly 32 bytes (base64-encoded).')
  }
  return key
}

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url')
}

function decrypt(payload: string): string {
  const raw = Buffer.from(payload, 'base64url')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export async function setSession(data: SessionData) {
  const store = await cookies()
  store.set(COOKIE_NAME, encrypt(JSON.stringify(data)), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 400,
  })
}

export async function getSession(): Promise<SessionData | null> {
  const store = await cookies()
  const raw = store.get(COOKIE_NAME)?.value
  if (!raw) return null
  try {
    return JSON.parse(decrypt(raw)) as SessionData
  } catch {
    return null
  }
}

export async function clearSession() {
  const store = await cookies()
  store.delete(COOKIE_NAME)
}
