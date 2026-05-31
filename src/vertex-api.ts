import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  ToolCall,
} from '@mariozechner/pi-ai'
import { calculateCost, createAssistantMessageEventStream } from '@mariozechner/pi-ai'

import { appendFileSync } from 'node:fs'

import { getAccessToken } from './auth'
import { buildStreamUrl, resolveConfig } from './config'
import { convertMessages, convertTools, mapStopReason, sanitizeSurrogates } from './messages'

/**
 * Opt-in diagnostics. Two independent levels, both off by default (zero
 * overhead when unset):
 *
 *   PI_VERTEX_DEBUG=1            → high-signal lines to stderr
 *   PI_VERTEX_LOG=/path/log.txt  → high-signal lines appended to a file
 *   PI_VERTEX_TRACE=1            → ALSO dump every raw SSE event (verbose)
 *
 * High-signal (debugLog): request shape, response status, http/SSE errors,
 * terminal stop_reason, and the per-turn `done` summary. This is enough to
 * diagnose wrong project/region, bad thinking payloads, oversized bodies,
 * and swallowed terminal errors.
 *
 * Verbose (trace): the full payload of every SSE event — each text /
 * thinking / tool-call delta and signature. Useful for streaming-level
 * issues (truncation, ordering, empty deltas) but very noisy (tens of lines
 * per turn), so it is gated behind its own flag and stays silent otherwise.
 *
 * Sinks: trace writes to whatever sink is active. If PI_VERTEX_TRACE is set
 * without PI_VERTEX_LOG/PI_VERTEX_DEBUG, it falls back to stderr so the flag
 * works on its own.
 *
 * This machinery exists because Vertex/Anthropic stream failures were
 * previously collapsed into a generic "Unknown error" with no recorded
 * cause: any unrecognized `stop_reason` mapped to 'error' and the raw reason
 * was discarded, while mid-stream SSE `error` events were not handled at all.
 */
const DEBUG_TO_STDERR = !!process.env.PI_VERTEX_DEBUG
const DEBUG_LOG_FILE = process.env.PI_VERTEX_LOG
const TRACE_ENABLED = !!process.env.PI_VERTEX_TRACE
const DEBUG_ENABLED = DEBUG_TO_STDERR || !!DEBUG_LOG_FILE || TRACE_ENABLED
// Trace with no explicit sink still needs somewhere to go → default to stderr.
const STDERR_ENABLED = DEBUG_TO_STDERR || (TRACE_ENABLED && !DEBUG_LOG_FILE)

function emit(event: string, detail?: unknown): void {
  let line = `[vertex-anthropic ${new Date().toISOString()}] ${event}`
  if (detail !== undefined) {
    line += ' ' + (typeof detail === 'string' ? detail : safeStringify(detail))
  }
  if (STDERR_ENABLED) console.error(line)
  if (DEBUG_LOG_FILE) {
    try {
      appendFileSync(DEBUG_LOG_FILE, line + '\n')
    } catch {
      // Never let diagnostics break the stream.
    }
  }
}

/** High-signal diagnostic line. Active under PI_VERTEX_DEBUG/LOG (or TRACE). */
function debugLog(event: string, detail?: unknown): void {
  if (!DEBUG_ENABLED) return
  emit(event, detail)
}

/** Verbose per-event trace. Active only under PI_VERTEX_TRACE. */
function trace(event: string, detail?: unknown): void {
  if (!TRACE_ENABLED) return
  emit(event, detail)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Parse Server-Sent Events from a Vertex AI streaming response.
 */
export async function* parseSSE(response: Response): AsyncGenerator<any> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    let eventType = ''
    let data = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        data = line.slice(6).trim()
      } else if (line === '' && data) {
        try {
          const parsed = JSON.parse(data)
          parsed._eventType = eventType
          yield parsed
        } catch {
          // Skip malformed JSON but log for debugging
          console.error(
            `[vertex-anthropic] Failed to parse SSE event: ${data.substring(0, 200)}`,
          )
        }
        eventType = ''
        data = ''
      }
    }
  }
}

const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
}

/**
 * Pi reasoning level → Anthropic adaptive-thinking effort level.
 *
 * Anthropic effort tiers (per docs):
 *   max    — Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6, Mythos Preview
 *   xhigh  — Opus 4.8 and Opus 4.7 only (sending to Sonnet/Haiku 4.6 returns 400)
 *   high   — default, all adaptive models
 *   medium — all
 *   low    — all
 *
 * pi has no level above xhigh, so pi xhigh maps to Anthropic 'max' to give
 * users access to the actual ceiling. We avoid 'xhigh' because it'd break
 * on Sonnet/Haiku 4.6. If you specifically want the intermediate 'xhigh'
 * tier on Opus 4.7/4.8, swap the xhigh entry below.
 */
type AdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const ADAPTIVE_EFFORT: Record<string, AdaptiveEffort> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
}

/**
 * Models newer than the 4-5 family (claude-opus-4-7, claude-sonnet-4-6, ...)
 * use Anthropic's adaptive-thinking API:
 *
 *   thinking: { type: 'adaptive' }
 *   output_config: { effort: 'low' | 'medium' | 'high' }
 *
 * instead of the older fixed-budget shape:
 *
 *   thinking: { type: 'enabled', budget_tokens: N }
 *
 * Sending `enabled` to a 4-6+ model returns:
 *   `"thinking.type.enabled" is not supported for this model.`
 *
 * Detected by id since callers often pass custom model ids like
 * `claude-opus-4-7@default` that aren't in our registered list.
 */
export function useAdaptiveThinking(modelId: string): boolean {
  const match = modelId.match(/claude-(?:opus|sonnet|haiku)-4-(\d+)/)
  if (!match) return false
  return parseInt(match[1], 10) >= 6
}

/**
 * Build the Anthropic Messages API request body for Vertex AI.
 */
export function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): any {
  const body: any = {
    anthropic_version: 'vertex-2023-10-16',
    messages: convertMessages(context.messages, model),
    // Default to 1/3 of model maxTokens to leave headroom for system prompt,
    // tool definitions, and intermediate thinking blocks.
    max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
    stream: true,
  }

  if (context.systemPrompt) {
    body.system = [
      {
        type: 'text',
        text: sanitizeSurrogates(context.systemPrompt),
        cache_control: { type: 'ephemeral' },
      },
    ]
  }

  if (context.tools) {
    body.tools = convertTools(context.tools)
  }

  if (options?.reasoning && model.reasoning) {
    if (useAdaptiveThinking(model.id)) {
      // On Claude Opus 4.7 (and Mythos Preview) thinking.display defaults
      // to "omitted" — thinking blocks still arrive but with empty
      // `thinking` strings. Opt in to "summarized" so the user actually
      // sees the reasoning summary. Opus 4.6 / Sonnet 4.6 default to
      // "summarized" anyway, so this is also safe (and forward-compatible)
      // on those models.
      // https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking#controlling-thinking-display
      body.thinking = { type: 'adaptive', display: 'summarized' }
      body.output_config = {
        effort: ADAPTIVE_EFFORT[options.reasoning] ?? 'medium',
      }
    } else {
      const customBudget =
        options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets]
      body.thinking = {
        type: 'enabled',
        budget_tokens: customBudget ?? THINKING_BUDGETS[options.reasoning] ?? 10240,
      }
    }
  }

  return body
}

/**
 * Stream a response from Vertex AI's Anthropic endpoint.
 * Produces a Pi AssistantMessageEventStream with proper event types.
 */
export function streamVertexAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  ;(async () => {
    try {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    }

    try {
      const config = resolveConfig()
      const project = (model as any).project || config.project
      const region = (model as any).region || config.region

      if (!project) {
        throw new Error(
          'No GCP project configured. Set ANTHROPIC_VERTEX_PROJECT_ID or run /login',
        )
      }

      const token = await getAccessToken()
      const vertexModelId = (model as any).vertexModelId || model.id
      const url = buildStreamUrl(region, project, vertexModelId)
      const body = buildRequestBody(model, context, options)

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      // Opt into Anthropic's 1M-context beta for models that advertise
      // more than the legacy 200k window. Without this header Vertex
      // silently caps requests at 200k even though Opus 4.7 (and the
      // 4.6 family via beta) support 1M tokens.
      // https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
      if (typeof model.contextWindow === 'number' && model.contextWindow > 200000) {
        headers['anthropic-beta'] = 'context-1m-2025-08-07'
      }

      debugLog('request', {
        url,
        model: model.id,
        vertexModelId,
        reasoning: options?.reasoning ?? null,
        thinking: body.thinking ?? null,
        output_config: body.output_config ?? null,
        max_tokens: body.max_tokens,
        messageCount: Array.isArray(body.messages) ? body.messages.length : null,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        anthropicBeta: headers['anthropic-beta'] ?? null,
        approxBodyBytes: JSON.stringify(body).length,
      })

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        debugLog('http_error', { status: response.status, body: errorText.slice(0, 2000) })
        throw new Error(`Vertex AI error (${response.status}): ${errorText}`)
      }
      debugLog('response_ok', { status: response.status })

      stream.push({ type: 'start', partial: output })

      type Block = (ThinkingContent | { type: 'text'; text: string } | (ToolCall & { partialJson: string })) & {
        index: number
      }
      const blocks = output.content as Block[]

      // Stream-lifecycle tracking for diagnostics. Anthropic streams open
      // with `message_start` and terminate with `message_stop`; a stream that
      // ends without `message_stop` was cut off (proxy/timeout/server reset),
      // which is a distinct failure from a real terminal stop_reason.
      let sawMessageStart = false
      let sawMessageStop = false
      let rawStopReason: string | undefined

      for await (const event of parseSSE(response)) {
        // Verbose: full raw event (every delta/signature). Noisy, trace-only.
        trace('sse', event)
        // Vertex/Anthropic can emit a terminal SSE `error` event mid-stream
        // (e.g. overloaded_error, api_error). Previously this fell through
        // every branch and was silently dropped. Surface it explicitly.
        if (event.type === 'error') {
          const payload = event.error ?? event
          debugLog('sse_error', payload)
          throw new Error(`Vertex SSE error event: ${safeStringify(payload)}`)
        }
        if (event.type === 'message_start') {
          sawMessageStart = true
          const usage = event.message?.usage
          if (usage) {
            output.usage.input = usage.input_tokens || 0
            output.usage.output = usage.output_tokens || 0
            output.usage.cacheRead = usage.cache_read_input_tokens || 0
            output.usage.cacheWrite = usage.cache_creation_input_tokens || 0
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite
            calculateCost(model, output.usage)
          }
        } else if (event.type === 'content_block_start') {
          const cb = event.content_block
          if (cb.type === 'text') {
            output.content.push({ type: 'text', text: '', index: event.index } as any)
            stream.push({
              type: 'text_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (cb.type === 'thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '',
              thinkingSignature: '',
              index: event.index,
            } as any)
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (cb.type === 'tool_use') {
            output.content.push({
              type: 'toolCall',
              id: cb.id,
              name: cb.name,
              arguments: {},
              partialJson: '',
              index: event.index,
            } as any)
            stream.push({
              type: 'toolcall_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_delta') {
          const index = blocks.findIndex((b) => b.index === event.index)
          const block = blocks[index]
          if (!block) continue

          if (event.delta.type === 'text_delta' && block.type === 'text') {
            block.text += event.delta.text
            stream.push({
              type: 'text_delta',
              contentIndex: index,
              delta: event.delta.text,
              partial: output,
            })
          } else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
            block.thinking += event.delta.thinking
            stream.push({
              type: 'thinking_delta',
              contentIndex: index,
              delta: event.delta.thinking,
              partial: output,
            })
          } else if (event.delta.type === 'input_json_delta' && block.type === 'toolCall') {
            ;(block as any).partialJson += event.delta.partial_json
            try {
              block.arguments = JSON.parse((block as any).partialJson)
            } catch {
              // Partial JSON, wait for more
            }
            stream.push({
              type: 'toolcall_delta',
              contentIndex: index,
              delta: event.delta.partial_json,
              partial: output,
            })
          } else if (event.delta.type === 'signature_delta' && block.type === 'thinking') {
            block.thinkingSignature =
              (block.thinkingSignature || '') + (event.delta as any).signature
          }
        } else if (event.type === 'content_block_stop') {
          const index = blocks.findIndex((b) => b.index === event.index)
          const block = blocks[index]
          if (!block) continue

          delete (block as any).index

          if (block.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex: index,
              content: block.text,
              partial: output,
            })
          } else if (block.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex: index,
              content: block.thinking,
              partial: output,
            })
          } else if (block.type === 'toolCall') {
            try {
              block.arguments = JSON.parse((block as any).partialJson)
            } catch {
              // Keep whatever we have
            }
            delete (block as any).partialJson
            stream.push({
              type: 'toolcall_end',
              contentIndex: index,
              toolCall: block,
              partial: output,
            })
          }
        } else if (event.type === 'message_stop') {
          sawMessageStop = true
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) {
            rawStopReason = event.delta.stop_reason
            output.stopReason = mapStopReason(event.delta.stop_reason)
            debugLog('stop_reason', {
              raw: rawStopReason,
              mapped: output.stopReason,
            })
          }
          if (event.usage) {
            output.usage.output = event.usage.output_tokens || output.usage.output
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite
            calculateCost(model, output.usage)
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error('Request was aborted')
      }

      // A terminal stop_reason that mapStopReason couldn't classify (e.g.
      // "refusal", or a stop_reason newer than this fork knows about) lands
      // here as stopReason === 'error'. Convert it into a real, inspectable
      // errorMessage instead of pushing a silent done:error that the UI
      // renders as "Unknown error".
      if (output.stopReason === 'error') {
        throw new Error(
          `Vertex stream stopped with unhandled stop_reason: ${
            rawStopReason ? `"${rawStopReason}"` : '(none received)'
          }`,
        )
      }

      // Saw the start of a message but never its end → the stream was cut off
      // before completion (connection reset, proxy timeout, etc.).
      if (sawMessageStart && !sawMessageStop) {
        throw new Error(
          `Vertex stream ended before message_stop (last stop_reason: ${
            rawStopReason ?? 'none'
          }, blocks: ${output.content.length})`,
        )
      }

      // Clean up internal tracking properties
      for (const block of output.content) delete (block as any).index

      debugLog('done', {
        stopReason: output.stopReason,
        rawStopReason: rawStopReason ?? null,
        // Per-block summary so the log shows whether a thinking block was
        // present and whether it actually carried summarized text/signature
        // (empty thinking => display 'omitted' / model suppressed summary;
        //  no thinking block at all => thinking was never requested).
        blocks: output.content.map((b: any) => ({
          type: b.type,
          thinkingChars: typeof b.thinking === 'string' ? b.thinking.length : undefined,
          sigChars: typeof b.thinkingSignature === 'string' ? b.thinkingSignature.length : undefined,
          textChars: typeof b.text === 'string' ? b.text.length : undefined,
        })),
        requestedThinking: !!(options?.reasoning && model.reasoning),
        usage: output.usage,
      })
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      stream.end()
    } catch (error) {
      for (const block of output.content) {
        delete (block as any).index
        delete (block as any).partialJson
      }
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)
      debugLog('error', {
        stopReason: output.stopReason,
        errorMessage: output.errorMessage,
        blocks: output.content.map((b: any) => b.type),
      })
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  } catch (error) {
    // Catch synchronous errors from IIFE setup (e.g., resolveConfig throws)
    const errorMsg = error instanceof Error ? error.message : JSON.stringify(error)
    console.error(`[vertex-anthropic] Synchronous error in stream: ${errorMsg}`)
  }
  })()

  return stream
}
