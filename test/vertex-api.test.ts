import { describe, it, expect } from 'vitest'
import { buildRequestBody, useAdaptiveThinking } from '../src/vertex-api'
import type { Model, Api, Context } from '@mariozechner/pi-ai'

function makeModel(id: string, reasoning = true): Model<Api> {
  return {
    provider: 'vertex-anthropic',
    api: 'vertex-anthropic-api' as Api,
    id,
    name: id,
    reasoning,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<Api>
}

const baseContext: Context = {
  messages: [{ role: 'user', content: 'hi' }],
} as Context

describe('useAdaptiveThinking', () => {
  it('returns true for 4-6+ claude models', () => {
    expect(useAdaptiveThinking('claude-opus-4-6')).toBe(true)
    expect(useAdaptiveThinking('claude-opus-4-7')).toBe(true)
    expect(useAdaptiveThinking('claude-opus-4-7@default')).toBe(true)
    expect(useAdaptiveThinking('claude-opus-4-8')).toBe(true)
    expect(useAdaptiveThinking('claude-opus-4-8@default')).toBe(true)
    expect(useAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
    expect(useAdaptiveThinking('claude-haiku-4-10')).toBe(true)
  })

  it('returns false for 4-5 and older claude models', () => {
    expect(useAdaptiveThinking('claude-opus-4-5')).toBe(false)
    expect(useAdaptiveThinking('claude-opus-4-5@20251101')).toBe(false)
    expect(useAdaptiveThinking('claude-sonnet-4-5@20250929')).toBe(false)
    expect(useAdaptiveThinking('claude-haiku-4-5@20251001')).toBe(false)
    expect(useAdaptiveThinking('claude-3-5-sonnet@20240620')).toBe(false)
    expect(useAdaptiveThinking('claude-3-opus@20240229')).toBe(false)
  })

  it('returns false for non-claude ids', () => {
    expect(useAdaptiveThinking('gemini-2.5-pro')).toBe(false)
    expect(useAdaptiveThinking('')).toBe(false)
  })
})

describe('buildRequestBody thinking shape', () => {
  it('uses adaptive shape for opus-4-7', () => {
    const body = buildRequestBody(makeModel('claude-opus-4-7@default'), baseContext, {
      reasoning: 'medium' as any,
    } as any)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.budget_tokens).toBeUndefined()
  })

  it('maps pi minimal to low and pi xhigh to max', () => {
    const minimal = buildRequestBody(makeModel('claude-opus-4-7@default'), baseContext, {
      reasoning: 'minimal' as any,
    } as any)
    expect(minimal.output_config).toEqual({ effort: 'low' })

    // pi xhigh -> Anthropic 'max' (true ceiling, valid on all adaptive
    // models including Sonnet 4.6). We intentionally don't map to
    // Anthropic's 'xhigh' tier because that is Opus-4.7-only and would
    // 400 elsewhere.
    const xhigh = buildRequestBody(makeModel('claude-sonnet-4-6'), baseContext, {
      reasoning: 'xhigh' as any,
    } as any)
    expect(xhigh.output_config).toEqual({ effort: 'max' })
  })

  it('uses legacy enabled shape for opus-4-5', () => {
    const body = buildRequestBody(makeModel('claude-opus-4-5@20251101'), baseContext, {
      reasoning: 'medium' as any,
    } as any)
    expect(body.thinking.type).toBe('enabled')
    expect(body.thinking.budget_tokens).toBe(10240)
    expect(body.output_config).toBeUndefined()
  })

  it('omits thinking when reasoning is not requested', () => {
    const body = buildRequestBody(makeModel('claude-opus-4-7@default'), baseContext, {} as any)
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('omits thinking when model is not reasoning-capable', () => {
    const body = buildRequestBody(
      makeModel('claude-opus-4-7@default', false),
      baseContext,
      { reasoning: 'high' as any } as any,
    )
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })
})
