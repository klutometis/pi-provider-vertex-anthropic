import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { createSign } from 'node:crypto'
import { exec } from './shell'

const GOOGLE_CLOUD_CLI_PATHS = [
  '/usr/local/bin/gcloud',
  '/usr/bin/gcloud',
  join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
  ...(platform() === 'win32' ? [
    'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
    'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
  ] : []),
  'gcloud',
  ...(platform() === 'win32' ? ['gcloud.cmd'] : []),
]

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const ADC_PATH = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')

// In-memory token cache
let cachedToken: { token: string; expiresAt: number } | null = null

/**
 * Find the Google Cloud CLI binary by searching common locations.
 * Returns undefined if no working CLI is found.
 */
export function findGoogleCloudCliPath(): string | undefined {
  for (const path of GOOGLE_CLOUD_CLI_PATHS) {
    try {
      const result = spawnSync(path, ['version'], { stdio: 'ignore', timeout: 2000 })
      if (result.status === 0) return path
    } catch {
      // Try next path
    }
  }
  return undefined
}

/**
 * Get an access token via service account JSON key file.
 * Uses GOOGLE_APPLICATION_CREDENTIALS to locate the key file.
 */
async function getServiceAccountToken(): Promise<string | null> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!keyPath || !existsSync(keyPath)) return null

  try {
    const key = JSON.parse(readFileSync(keyPath, 'utf-8'))
    if (key.type !== 'service_account') return null

    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(
      JSON.stringify({
        iss: key.client_email,
        scope: SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url')

    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const signature = signer.sign(key.private_key, 'base64url')
    const jwt = `${header}.${claims}.${signature}`

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    })

    if (!response.ok) return null
    const data = (await response.json()) as { access_token: string }
    return data.access_token
  } catch {
    return null
  }
}

/**
 * Get an access token via Application Default Credentials (ADC).
 * Reads the refresh token from the Google Cloud ADC file.
 */
async function getADCToken(): Promise<string | null> {
  if (!existsSync(ADC_PATH)) return null

  try {
    const creds = JSON.parse(readFileSync(ADC_PATH, 'utf-8'))
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) return null

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
      }).toString(),
    })

    if (!response.ok) return null
    const data = (await response.json()) as { access_token: string }
    return data.access_token
  } catch {
    return null
  }
}

/**
 * Get an access token via the Google Cloud CLI.
 * Throws if no CLI is found or authentication fails.
 */
export function getGoogleCloudCliToken(cliPath?: string): string {
  const cmd = cliPath || findGoogleCloudCliPath()
  if (!cmd) {
    throw new Error(
      'gcloud CLI not found. Install from: https://cloud.google.com/sdk/docs/install',
    )
  }
  return exec(cmd, ['auth', 'print-access-token'], { timeout: 10000 })
}

/**
 * Get a valid access token, trying strategies in order:
 *  1. Service account (GOOGLE_APPLICATION_CREDENTIALS)
 *  2. Application Default Credentials (~/.config/gcloud/application_default_credentials.json)
 *  3. Google Cloud CLI (gcloud auth print-access-token)
 *
 * Tokens are cached in memory and refreshed at 55 minutes.
 */
export async function getAccessToken(cliPath?: string): Promise<string> {
  // Return cached token if still valid (55 min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token
  }

  // Try service account first
  const saToken = await getServiceAccountToken()
  if (saToken) {
    cachedToken = { token: saToken, expiresAt: Date.now() + 55 * 60 * 1000 }
    return saToken
  }

  // Try ADC
  const adcToken = await getADCToken()
  if (adcToken) {
    cachedToken = { token: adcToken, expiresAt: Date.now() + 55 * 60 * 1000 }
    return adcToken
  }

  // Fall back to Google Cloud CLI (not cached - it manages its own token refresh)
  const token = getGoogleCloudCliToken(cliPath)
  if (!token || token.length < 20) {
    throw new Error('Failed to get access token. Run: gcloud auth login')
  }
  return token
}

/**
 * Clear the cached token (useful for forcing re-auth).
 */
export function clearTokenCache(): void {
  cachedToken = null
}
