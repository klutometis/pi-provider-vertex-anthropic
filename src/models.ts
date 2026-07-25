export const PROVIDER_NAME = 'vertex-anthropic'
export const API_NAME = 'vertex-anthropic-api'

export interface VertexModel {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

/**
 * Claude models available on Google Cloud Vertex AI.
 * Pricing is per 1M tokens.
 */
export const VERTEX_MODELS: VertexModel[] = [
  {
    id: 'claude-opus-5@default',
    name: 'Claude Opus 5 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    // Opus 5 keeps Opus 4.8's pricing, the 1M context window, and 128k max
    // output. Adaptive thinking with low/medium/high/xhigh(->max) effort.
    // See https://www.anthropic.com/news/claude-opus-5
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'claude-opus-4-8@default',
    name: 'Claude Opus 4.8 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    // Opus 4.8 keeps Opus 4.7 pricing and the 1M context window, and
    // raises max output to 128k. Adaptive thinking with new 'extra'
    // (xhigh) and 'max' effort tiers.
    // See https://www.anthropic.com/news/claude-opus-4-8
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'claude-opus-4-7@default',
    name: 'Claude Opus 4.7 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    // Opus 4.7 ships with a 1M context window at standard pricing.
    // See https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6@default',
    name: 'Claude Sonnet 4.6 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: 'claude-haiku-4-6@default',
    name: 'Claude Haiku 4.6 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-opus-4-5@20251101',
    name: 'Claude Opus 4.5 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-sonnet-4-5@20250929',
    name: 'Claude Sonnet 4.5 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-haiku-4-5@20251001',
    name: 'Claude Haiku 4.5 (Vertex)',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-3-5-sonnet-v2@20241022',
    name: 'Claude 3.5 Sonnet v2 (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'claude-3-5-sonnet@20240620',
    name: 'Claude 3.5 Sonnet (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'claude-3-5-haiku@20241022',
    name: 'Claude 3.5 Haiku (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'claude-3-opus@20240229',
    name: 'Claude 3 Opus (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: 'claude-3-sonnet@20240229',
    name: 'Claude 3 Sonnet (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: 'claude-3-haiku@20240307',
    name: 'Claude 3 Haiku (Vertex)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
    contextWindow: 200000,
    maxTokens: 4096,
  },
]
