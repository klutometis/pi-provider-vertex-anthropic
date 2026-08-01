import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveProject, resolveRegion, buildEndpointHost, buildStreamUrl } from '../src/config'

describe('resolveProject', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
    delete process.env.GOOGLE_CLOUD_PROJECT
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns ANTHROPIC_VERTEX_PROJECT_ID first', () => {
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'claude-project'
    process.env.GOOGLE_CLOUD_PROJECT = 'gcp-project'
    expect(resolveProject()).toBe('claude-project')
  })

  it('falls back to GOOGLE_CLOUD_PROJECT', () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'gcp-project'
    expect(resolveProject()).toBe('gcp-project')
  })

  it('falls back to persisted credentials', () => {
    expect(resolveProject({ project: 'persisted-project' })).toBe('persisted-project')
  })

  it('returns undefined when nothing is set', () => {
    expect(resolveProject()).toBeUndefined()
  })

  it('env vars take priority over persisted credentials', () => {
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'env-project'
    expect(resolveProject({ project: 'persisted-project' })).toBe('env-project')
  })
})

describe('resolveRegion', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.CLOUD_ML_REGION
    delete process.env.VERTEX_LOCATION
    delete process.env.VERTEXAI_LOCATION
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns CLOUD_ML_REGION first', () => {
    process.env.CLOUD_ML_REGION = 'us-east5'
    process.env.VERTEX_LOCATION = 'europe-west1'
    expect(resolveRegion()).toBe('us-east5')
  })

  it('falls back to VERTEX_LOCATION', () => {
    process.env.VERTEX_LOCATION = 'europe-west1'
    expect(resolveRegion()).toBe('europe-west1')
  })

  it('falls back to VERTEXAI_LOCATION', () => {
    process.env.VERTEXAI_LOCATION = 'asia-southeast1'
    expect(resolveRegion()).toBe('asia-southeast1')
  })

  it('falls back to persisted credentials', () => {
    expect(resolveRegion({ region: 'us-central1' })).toBe('us-central1')
  })

  it('defaults to global', () => {
    expect(resolveRegion()).toBe('global')
  })
})

describe('buildEndpointHost', () => {
  it('uses region prefix for non-global regions', () => {
    expect(buildEndpointHost('us-east5')).toBe('us-east5-aiplatform.googleapis.com')
  })

  it('uses no prefix for global region', () => {
    expect(buildEndpointHost('global')).toBe('aiplatform.googleapis.com')
  })

  it('handles europe region', () => {
    expect(buildEndpointHost('europe-west1')).toBe('europe-west1-aiplatform.googleapis.com')
  })
})

describe('buildStreamUrl', () => {
  it('builds correct URL for regional endpoint', () => {
    const url = buildStreamUrl('us-east5', 'my-project', 'claude-opus-4-6')
    expect(url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-opus-4-6:streamRawPredict',
    )
  })

  it('builds correct URL for global endpoint', () => {
    const url = buildStreamUrl('global', 'my-project', 'claude-opus-4-6')
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models/claude-opus-4-6:streamRawPredict',
    )
  })
})
