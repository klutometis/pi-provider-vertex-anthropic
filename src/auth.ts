import { readFileSync, existsSync } from 'node:fs'
import { spawnSync, execSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { createSign } from 'node:crypto'
import { exec } from './shell'

const GOOGLE_CLOUD_CLI_PATHS = [
  '/usr/local/bin/gcloud',
  '/usr/bin/gcloud',
  join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
]

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** Resolve the ADC file path (Windows uses %APPDATA%, Unix uses ~/.config). */
function getAdcPath(): string {
  if (platform() === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json')
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')
}

// In-memory token cache
let cachedToken: { token: string; expiresAt: number } | null = null

/**
 * Verify that a gcloud command/path is executable.
 * On Windows, .cmd files and PATH lookups require cmd.exe or shell mode.
 */
function isGcloudWorking(command: string): boolean {
  try {
    if (platform() === 'win32') {
      const result = spawnSync('cmd.exe', ['/c', command, 'version'], {
        stdio: 'ignore',
        timeout: 5000,
        env: process.env,
      })
      return result.status === 0
    }
    const result = spawnSync(command, ['version'], {
      stdio: 'ignore',
      timeout: 5000,
      env: process.env,
    })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Find gcloud in the system PATH using the shell.
 * Works cross-platform: uses 'where' on Windows, 'which' on Unix-like systems.
 * Returns a command string that can be executed, or undefined.
 */
function findGcloudInPath(): string | undefined {
  try {
    const findCmd = platform() === 'win32' ? 'where gcloud' : 'which gcloud'
    const output = execSync(findCmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      env: process.env,
      shell: true,
    }).trim()
    if (!output) return undefined

    const paths = output.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)

    if (platform() === 'win32') {
      // `where` lists the bash script before gcloud.cmd; prefer the .cmd entry.
      const cmdPath = paths.find((p) => p.toLowerCase().endsWith('.cmd'))
      if (cmdPath && isGcloudWorking(cmdPath)) return cmdPath
      if (isGcloudWorking('gcloud')) return 'gcloud'
      return undefined
    }

    const first = paths[0]
    if (first && isGcloudWorking(first)) return first
  } catch {
    // Ignore errors
  }
  return undefined
}

/**
 * Find the Google Cloud CLI binary by searching common locations and system PATH.
 * Returns undefined if no working CLI is found.
 */
export function findGoogleCloudCliPath(): string | undefined {
  const pathResult = findGcloudInPath()
  if (pathResult) return pathResult

  for (const path of GOOGLE_CLOUD_CLI_PATHS) {
    if (isGcloudWorking(path)) return path
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
  const adcPath = getAdcPath()
  if (!existsSync(adcPath)) return null

  try {
    const creds = JSON.parse(readFileSync(adcPath, 'utf-8'))
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
 *  2. Application Default Credentials (%APPDATA%/gcloud on Windows, ~/.config/gcloud on Unix)
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
