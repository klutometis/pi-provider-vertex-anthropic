import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildRequestBody, useAdaptiveThinking, streamVertexAnthropic } from '../src/vertex-api'
import type { Model, Api, Context } from '@mariozechner/pi-ai'

vi.mock('../src/auth', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
}))
vi.mock('../src/config', () => ({
  resolveConfig: () => ({ project: 'test-project', region: 'us-central1' }),
  buildStreamUrl: () => 'https://example.test/stream',
}))

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

/** Build a fake Vertex SSE streaming Response from a list of event objects. */
function sseResponse(events: any[]): Response {
  const text = events
    .map((e) => `event: ${e._eventType || e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function consume(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = []
  for await (const e of stream) events.push(e)
  return events
}

const THINKING_SEQUENCE = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  { type: 'content_block_stop', index: 0 },
]

describe('diagnostic logging levels (PI_VERTEX_DEBUG vs PI_VERTEX_TRACE)', () => {
  const ENV_KEYS = ['PI_VERTEX_DEBUG', 'PI_VERTEX_LOG', 'PI_VERTEX_TRACE'] as const
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  // Re-import the module with env set *before* evaluation, since the level
  // flags are resolved at module load. Returns captured stderr lines.
  async function runWithEnv(env: Record<string, string>): Promise<string[]> {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    for (const k of ENV_KEYS) delete process.env[k]
    Object.assign(process.env, env)
    vi.resetModules()
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((l?: any) => {
      lines.push(String(l))
    })
    const mod = await import('../src/vertex-api')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]),
      ),
    )
    await consume(mod.streamVertexAnthropic(makeModel('claude-opus-4-8@default'), baseContext, {} as any))
    return lines
  }

  it('emits nothing when all flags are off', async () => {
    const lines = await runWithEnv({})
    expect(lines).toHaveLength(0)
  })

  it('DEBUG emits high-signal lines but NOT per-event sse traces', async () => {
    const lines = await runWithEnv({ PI_VERTEX_DEBUG: '1' })
    expect(lines.some((l) => l.includes('] request '))).toBe(true)
    expect(lines.some((l) => l.includes('] done '))).toBe(true)
    expect(lines.some((l) => l.includes('] sse '))).toBe(false)
  })

  it('TRACE additionally emits verbose per-event sse lines', async () => {
    const lines = await runWithEnv({ PI_VERTEX_TRACE: '1' })
    expect(lines.some((l) => l.includes('] request '))).toBe(true)
    const sseLines = lines.filter((l) => l.includes('] sse '))
    expect(sseLines.length).toBeGreaterThan(1)
    // Verbose => the full raw event payload is present, not just its type.
    expect(sseLines.some((l) => l.includes('text_delta'))).toBe(true)
  })
})

describe('streamVertexAnthropic error diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('surfaces an unhandled terminal stop_reason as a real errorMessage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ...THINKING_SEQUENCE,
          { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 5 } },
          // intentionally no message_stop
        ]),
      ),
    )
    const events = await consume(
      streamVertexAnthropic(makeModel('claude-opus-4-8@default'), baseContext, {
        reasoning: 'high',
      } as any),
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(err.error.stopReason).toBe('error')
    expect(err.error.errorMessage).toContain('refusal')
    // The completed thinking block is preserved for inspection.
    expect(err.error.content.some((b: any) => b.type === 'thinking')).toBe(true)
  })

  it('surfaces a mid-stream SSE error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ]),
      ),
    )
    const events = await consume(
      streamVertexAnthropic(makeModel('claude-opus-4-8@default'), baseContext, {} as any),
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(err.error.errorMessage).toContain('overloaded_error')
  })

  it('flags a stream cut off before message_stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(THINKING_SEQUENCE)))
    const events = await consume(
      streamVertexAnthropic(makeModel('claude-opus-4-8@default'), baseContext, {
        reasoning: 'high',
      } as any),
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(err.error.errorMessage).toContain('before message_stop')
  })

  it('completes normally on a well-formed stream (regression)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ...THINKING_SEQUENCE,
          { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]),
      ),
    )
    const events = await consume(
      streamVertexAnthropic(makeModel('claude-opus-4-8@default'), baseContext, {
        reasoning: 'high',
      } as any),
    )
    expect(events.find((e) => e.type === 'error')).toBeUndefined()
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    expect(done.reason).toBe('stop')
    expect(done.message.errorMessage).toBeUndefined()
  })
})

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
