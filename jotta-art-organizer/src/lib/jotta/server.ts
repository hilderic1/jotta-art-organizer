import { getSession, setSession } from './session'
import { refreshAccessToken } from './auth'

// Refresh a bit before actual expiry so a request doesn't start with a
// token that dies mid-flight.
const EXPIRY_BUFFER_MS = 60_000

export async function requireAccessToken(): Promise<{
  accessToken: string
  username: string
}> {
  const session = await getSession()
  if (!session) {
    throw new Error('NOT_AUTHENTICATED')
  }

  if (session.accessToken && session.accessTokenExpiresAt > Date.now() + EXPIRY_BUFFER_MS) {
    return { accessToken: session.accessToken, username: session.username }
  }

  const { accessToken, refreshToken, expiresIn } = await refreshAccessToken(session.refreshToken)

  // Persist the rotated refresh token (and cached access token) immediately
  // so the next request reuses it instead of refreshing again.
  await setSession({
    username: session.username,
    refreshToken,
    accessToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  })

  return { accessToken, username: session.username }
}
