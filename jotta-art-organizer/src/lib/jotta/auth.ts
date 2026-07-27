const CLIENT_ID = 'jottacli'

type LoginToken = {
  username: string
  realm: string
  well_known_link: string
  auth_token: string
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

function decodeLoginToken(personalLoginToken: string): LoginToken {
  let json: string
  try {
    json = Buffer.from(personalLoginToken.trim(), 'base64').toString('utf8')
  } catch {
    throw new Error('Personal login token is not valid base64.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Personal login token did not decode to valid JSON. Copy it again from Jottacloud settings.')
  }
  const p = parsed as Partial<LoginToken>
  if (!p.username || !p.well_known_link || !p.auth_token) {
    throw new Error('Decoded login token is missing expected fields.')
  }
  return p as LoginToken
}

async function getTokenEndpoint(wellKnownLink: string): Promise<string> {
  const res = await fetch(wellKnownLink)
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery document (${res.status}).`)
  }
  const doc = (await res.json()) as { token_endpoint?: string }
  if (!doc.token_endpoint) {
    throw new Error('OIDC discovery document did not contain a token_endpoint.')
  }
  return doc.token_endpoint
}

export async function exchangePersonalLoginToken(personalLoginToken: string): Promise<{
  username: string
  accessToken: string
  refreshToken: string
  expiresIn: number
}> {
  const loginToken = decodeLoginToken(personalLoginToken)
  const tokenEndpoint = await getTokenEndpoint(loginToken.well_known_link)

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'password',
    username: loginToken.username,
    password: loginToken.auth_token,
    scope: 'openid offline_access',
  })

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jottacloud rejected the personal login token (${res.status}): ${text.slice(0, 300)}`)
  }

  const token = (await res.json()) as TokenResponse
  return {
    username: loginToken.username,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  }
}

const TOKEN_ENDPOINT =
  'https://id.jottacloud.com/auth/realms/jottacloud/protocol/openid-connect/token'

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to refresh Jottacloud access token (${res.status}): ${text.slice(0, 300)}`)
  }

  // Jottacloud rotates refresh tokens on every use — the old one becomes
  // invalid, so the new refresh_token must replace it in storage or the
  // *next* refresh will fail (and repeated reuse of a stale one can trigger
  // Jottacloud's reuse-detection and revoke the whole session).
  const token = (await res.json()) as TokenResponse
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expires_in }
}
