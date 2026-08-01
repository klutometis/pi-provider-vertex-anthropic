import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')
const DEFAULT_REGION = 'global'

export interface PersistedCredentials {
  project?: string
  region?: string
}

export interface VertexConfig {
  project: string
  region: string
}

/**
 * Read persisted credentials from ~/.pi/agent/auth.json.
 * These are stored by the /login interactive flow.
 */
export function getPersistedCredentials(): PersistedCredentials {
  try {
    const data = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    const cred = data['vertex-anthropic']
    if (cred?.type === 'oauth') {
      return { project: cred.project, region: cred.region }
    }
  } catch {
    // No persisted credentials available
  }
  return {}
}

/**
 * Resolve the GCP project ID from environment variables and persisted credentials.
 *
 * Priority:
 *  1. ANTHROPIC_VERTEX_PROJECT_ID (Claude CLI)
 *  2. GOOGLE_CLOUD_PROJECT (Opencode / standard GCP)
 *  3. Persisted credentials from auth.json
 */
export function resolveProject(persisted?: PersistedCredentials): string | undefined {
  return (
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    persisted?.project ||
    undefined
  )
}

/**
 * Resolve the Vertex AI region from environment variables and persisted credentials.
 *
 * Priority:
 *  1. CLOUD_ML_REGION (Claude CLI)
 *  2. VERTEX_LOCATION (Opencode)
 *  3. VERTEXAI_LOCATION (Opencode alternative)
 *  4. Persisted credentials from auth.json
 *  5. Default: us-east5
 */
export function resolveRegion(persisted?: PersistedCredentials): string {
  return (
    process.env.CLOUD_ML_REGION ||
    process.env.VERTEX_LOCATION ||
    process.env.VERTEXAI_LOCATION ||
    persisted?.region ||
    DEFAULT_REGION
  )
}

/** Regional fallbacks when the default region is `global` and a model 404s there. */
export const GLOBAL_MODEL_FALLBACK_REGIONS = [
  'us-east5',
  'us-central1',
  'europe-west1',
  'us-east4',
] as const

/**
 * Build possible VERTEX_REGION_* env var names for a model id (Claude Code compatible).
 */
export function vertexRegionEnvKeys(modelId: string): string[] {
  const base = modelId.split('@')[0]
  const keys = [`VERTEX_REGION_${base.replace(/-/g, '_').toUpperCase()}`]

  const versioned = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/.exec(base)
  if (versioned) {
    const [, family, major, minor] = versioned
    keys.push(`VERTEX_REGION_CLAUDE_${major}_${minor}_${family.toUpperCase()}`)
    keys.push(`VERTEX_REGION_CLAUDE_${major}_${minor}_${family}`)
  }

  const majorOnly = /^claude-(opus|sonnet|haiku)-(\d+)$/.exec(base)
  if (majorOnly) {
    const [, family, major] = majorOnly
    keys.push(`VERTEX_REGION_CLAUDE_${major}_${family.toUpperCase()}`)
    keys.push(`VERTEX_REGION_CLAUDE_${major}_${family}`)
  }

  return keys
}

/**
 * Resolve the Vertex region for a specific model.
 * Checks VERTEX_REGION_* overrides (same as Claude Code), then the default region.
 */
export function resolveModelRegion(modelId: string, defaultRegion: string): string {
  for (const key of vertexRegionEnvKeys(modelId)) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return defaultRegion
}

/**
 * Build the Vertex AI endpoint hostname.
 * The `global` region uses `aiplatform.googleapis.com` without a region prefix.
 */
export function buildEndpointHost(region: string): string {
  return region === 'global'
    ? 'aiplatform.googleapis.com'
    : `${region}-aiplatform.googleapis.com`
}

/**
 * Build a regional Vertex AI model action URL (streamRawPredict, countTokens, etc.).
 */
export function buildModelActionUrl(
  region: string,
  project: string,
  modelId: string,
  action: string,
): string {
  const host = buildEndpointHost(region)
  return `https://${host}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${encodeURIComponent(modelId)}:${action}`
}

/**
 * Build the full Vertex AI streamRawPredict URL for a given model.
 */
export function buildStreamUrl(region: string, project: string, modelId: string): string {
  return buildModelActionUrl(region, project, modelId, 'streamRawPredict')
}

/**
 * Resolve full config from env vars and persisted credentials.
 */
export function resolveConfig(): VertexConfig {
  const persisted = getPersistedCredentials()
  return {
    project: resolveProject(persisted) || '',
    region: resolveRegion(persisted),
  }
}
