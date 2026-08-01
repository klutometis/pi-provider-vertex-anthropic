import { getAccessToken } from './auth'
import {
  GLOBAL_MODEL_FALLBACK_REGIONS,
  buildModelActionUrl,
  resolveConfig,
  resolveModelRegion,
} from './config'
import { VERTEX_MODELS, type VertexModel } from './models'

export type VertexModelWithRouting = VertexModel & { region?: string; project?: string }

export type ModelDiscoveryResult =
  | { ok: true; models: VertexModelWithRouting[]; project: string; region: string }
  | { ok: false; error: string }

const DEFAULT_PRICING: VertexModel['cost'] = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
}

const PRICING_BY_ID = new Map<string, VertexModel['cost']>(
  VERTEX_MODELS.map((model) => [model.id, model.cost]),
)

/**
 * Candidate model IDs to probe. Same strategy as Claude Code startup checks:
 * call countTokens on each model; 404 means unavailable in that project/region.
 */
export const CANDIDATE_MODEL_IDS = [
  // Claude Code defaults / recent Vertex releases
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-5@20251101',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5@20250929',
  'claude-haiku-4-5@20251001',
  // Bundled static catalog
  ...VERTEX_MODELS.map((model) => model.id),
]

function pricingForModelId(modelId: string): VertexModel['cost'] {
  return (
    PRICING_BY_ID.get(modelId) ??
    PRICING_BY_ID.get(modelId.split('@')[0]) ??
    DEFAULT_PRICING
  )
}

function metadataForModelId(modelId: string): VertexModel | undefined {
  return (
    VERTEX_MODELS.find((model) => model.id === modelId) ??
    VERTEX_MODELS.find((model) => model.id === modelId.split('@')[0])
  )
}

export function catalogModelForId(
  modelId: string,
  routing?: { region?: string; project?: string },
): VertexModelWithRouting {
  const known = metadataForModelId(modelId)
  const newer = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(modelId)
  const major = newer ? parseInt(newer[1], 10) : 0
  const minor = newer && newer[2] ? parseInt(newer[2], 10) : 0
  const isNewer = major >= 5 || (major === 4 && minor >= 6)

  const model: VertexModelWithRouting = known
    ? { ...known }
    : {
        id: modelId,
        name: `${modelId} (Vertex)`,
        reasoning: isNewer,
        input: ['text', 'image'],
        contextWindow: isNewer ? 1000000 : 200000,
        maxTokens: isNewer ? 64000 : 8192,
        cost: pricingForModelId(modelId),
      }

  if (routing?.region) model.region = routing.region
  if (routing?.project) model.project = routing.project
  return model
}

/** Org-policy block on countTokens — model exists but cannot be used in this project. */
export function isOrgPolicyBlock(bodyText: string): boolean {
  const body = bodyText.toLowerCase()
  return (
    body.includes('allowedmodels') ||
    body.includes('disallowed gen ai model') ||
    body.includes('control-model-access') ||
    body.includes('constraints/vertexai.allowedmodels')
  )
}

/**
 * True when countTokens indicates the model is callable in this project/region.
 *
 * Only two positive signals (matches Claude Code startup checks):
 * - 200 with token count
 * - 400 "countTokens is infeasible" (model exists and accepts predict)
 *
 * Rejects org-policy blocks, "not servable in region", 404, and 403.
 */
export function isModelProbeAvailable(status: number, bodyText = ''): boolean {
  if (status === 404 || status === 403) return false
  if (isOrgPolicyBlock(bodyText)) return false

  const body = bodyText.toLowerCase()
  if (body.includes('not servable in region')) return false

  if (status === 200) return true
  if (status === 400 && body.includes('infeasible')) return true

  return false
}

/** @deprecated Use isModelProbeAvailable */
export function isModelAvailableStatus(status: number): boolean {
  return isModelProbeAvailable(status)
}

function regionsToProbeForModel(modelId: string, defaultRegion: string): string[] {
  const primary = resolveModelRegion(modelId, defaultRegion)
  const regions = [primary]

  if (defaultRegion === 'global' && primary === 'global') {
    for (const fallback of GLOBAL_MODEL_FALLBACK_REGIONS) {
      if (!regions.includes(fallback)) regions.push(fallback)
    }
  }

  return regions
}

/**
 * Probe candidate models with countTokens on the inference endpoint.
 * Uses per-model VERTEX_REGION_* overrides and regional fallbacks when default is global.
 */
export async function probeModelAvailability(
  project: string,
  defaultRegion: string,
  modelIds: string[],
  token: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; region: string }>> {
  const available: Array<{ id: string; region: string }> = []
  const probeBody = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
  })

  await Promise.all(
    modelIds.map(async (modelId) => {
      if (signal?.aborted) return

      let blockedByPolicy = false

      for (const region of regionsToProbeForModel(modelId, defaultRegion)) {
        try {
          const url = buildModelActionUrl(region, project, modelId, 'countTokens')
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: probeBody,
            signal,
          })
          const bodyText = await response.text().catch(() => '')

          if (isOrgPolicyBlock(bodyText)) {
            blockedByPolicy = true
            return
          }

          if (isModelProbeAvailable(response.status, bodyText)) {
            available.push({ id: modelId, region })
            return
          }
        } catch {
          // Try next region.
        }
      }

      if (blockedByPolicy) return
    }),
  )

  return available
}

function candidateModelIds(extraModelIds: string[] = []): string[] {
  return [...new Set([...CANDIDATE_MODEL_IDS, ...extraModelIds])]
}

/**
 * Discover Claude models available in the configured GCP project.
 * Uses the same countTokens probe strategy as Claude Code's /setup-vertex wizard.
 */
export async function discoverVertexModels(options?: {
  signal?: AbortSignal
  extraModelIds?: string[]
}): Promise<ModelDiscoveryResult> {
  const config = resolveConfig()
  if (!config.project) {
    return {
      ok: false,
      error:
        'No GCP project configured. Run /login for vertex-anthropic or set GOOGLE_CLOUD_PROJECT.',
    }
  }

  try {
    const token = await getAccessToken()
    const modelIds = candidateModelIds(options?.extraModelIds)
    const available = await probeModelAvailability(
      config.project,
      config.region,
      modelIds,
      token,
      options?.signal,
    )

    if (available.length === 0) {
      return {
        ok: false,
        error: `No Claude models available for project ${config.project} (default region ${config.region}).`,
      }
    }

    const models = available
      .map(({ id, region }) =>
        catalogModelForId(id, { region, project: config.project }),
      )
      .sort((a, b) => a.id.localeCompare(b.id))

    return {
      ok: true,
      models,
      project: config.project,
      region: config.region,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
