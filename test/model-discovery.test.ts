import { describe, expect, it } from 'vitest'

import {
  CANDIDATE_MODEL_IDS,
  catalogModelForId,
  isModelAvailableStatus,
  isModelProbeAvailable,
} from '../src/model-discovery'
import { resolveModelRegion, vertexRegionEnvKeys } from '../src/config'

describe('isModelProbeAvailable', () => {
  it('treats 404 as unavailable', () => {
    expect(isModelProbeAvailable(404)).toBe(false)
  })

  it('treats 403 as unavailable', () => {
    expect(isModelProbeAvailable(403)).toBe(false)
  })

  it('treats countTokens infeasible 400 as available (model exists)', () => {
    expect(
      isModelProbeAvailable(400, 'countTokens is infeasible for projects/demo'),
    ).toBe(true)
  })

  it('treats org policy blocks as unavailable', () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message:
          'Organization Policy constraint constraints/vertexai.allowedModels violated attempting to use a disallowed Gen AI model claude-3-5-haiku',
        status: 'FAILED_PRECONDITION',
      },
    })
    expect(isModelProbeAvailable(400, body)).toBe(false)
  })

  it('treats not servable in region as unavailable', () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message:
          'Publisher Model `projects/demo/locations/us-central1/publishers/anthropic/models/claude-3-5-haiku@20241022` is not servable in region us-central1.',
        status: 'FAILED_PRECONDITION',
      },
    })
    expect(isModelProbeAvailable(400, body)).toBe(false)
  })

  it('treats generic 400 without infeasible as unavailable', () => {
    expect(isModelProbeAvailable(400, 'bad request')).toBe(false)
  })

  it('treats 200 as available', () => {
    expect(isModelProbeAvailable(200)).toBe(true)
  })
})

describe('isModelAvailableStatus', () => {
  it('delegates to isModelProbeAvailable for status-only checks', () => {
    expect(isModelAvailableStatus(404)).toBe(false)
    expect(isModelAvailableStatus(400)).toBe(false)
  })
})

describe('catalogModelForId', () => {
  it('returns bundled metadata for known models', () => {
    const model = catalogModelForId('claude-haiku-4-5@20251001')
    expect(model.name).toBe('Claude Haiku 4.5 (Vertex)')
    expect(model.reasoning).toBe(true)
  })

  it('attaches routing metadata when provided', () => {
    const model = catalogModelForId('claude-haiku-4-5@20251001', {
      region: 'us-east5',
      project: 'demo',
    })
    expect(model.region).toBe('us-east5')
    expect(model.project).toBe('demo')
  })

  it('creates a stub for unknown newer models', () => {
    const model = catalogModelForId('claude-sonnet-4-6')
    expect(model.id).toBe('claude-sonnet-4-6')
    expect(model.contextWindow).toBe(1000000)
  })
})

describe('vertexRegionEnvKeys', () => {
  it('includes Claude Code style keys for haiku 4.5', () => {
    expect(vertexRegionEnvKeys('claude-haiku-4-5@20251001')).toContain(
      'VERTEX_REGION_CLAUDE_HAIKU_4_5',
    )
  })

  it('includes Claude Code style keys for sonnet 4.6', () => {
    expect(vertexRegionEnvKeys('claude-sonnet-4-6')).toContain(
      'VERTEX_REGION_CLAUDE_4_6_SONNET',
    )
  })
})

describe('resolveModelRegion', () => {
  it('uses VERTEX_REGION override when set', () => {
    const prev = process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5
    process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5 = 'us-east5'
    expect(resolveModelRegion('claude-haiku-4-5@20251001', 'global')).toBe('us-east5')
    if (prev === undefined) delete process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5
    else process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5 = prev
  })
})

describe('CANDIDATE_MODEL_IDS', () => {
  it('includes Claude Code defaults and bundled catalog entries', () => {
    expect(CANDIDATE_MODEL_IDS).toContain('claude-opus-4-8')
    expect(CANDIDATE_MODEL_IDS).toContain('claude-sonnet-4-6')
    expect(CANDIDATE_MODEL_IDS).toContain('claude-haiku-4-5@20251001')
    expect(CANDIDATE_MODEL_IDS).toContain('claude-opus-4-6')
  })
})
