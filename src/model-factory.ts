import type { ToolRegistry } from './tool.js'
import type { ModelAdapter } from './types.js'
import type { RuntimeConfig } from './config.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import { GeminiModelAdapter } from './gemini-adapter.js'
import { OpenAIModelAdapter } from './openai-adapter.js'
import { MockModelAdapter } from './mock-model.js'

/**
 * Supported model provider types.
 *
 *   - 'anthropic'  — Claude models via Anthropic Messages API
 *   - 'gemini'     — Google Gemini via generateContent API
 *   - 'openai'     — Any OpenAI-compatible API (GPT, DeepSeek, Qwen, Ollama, etc.)
 *   - 'mock'       — Offline mock for testing
 */
export type ModelProvider = 'anthropic' | 'gemini' | 'openai' | 'mock'

/**
 * Known model-name prefixes and their providers.
 * Order matters — first match wins.
 */
const MODEL_PREFIX_MAP: Array<{ prefix: string; provider: ModelProvider }> = [
  // Google Gemini
  { prefix: 'gemini', provider: 'gemini' },

  // Anthropic Claude
  { prefix: 'claude', provider: 'anthropic' },

  // OpenAI
  { prefix: 'gpt-', provider: 'openai' },
  { prefix: 'o1', provider: 'openai' },
  { prefix: 'o3', provider: 'openai' },
  { prefix: 'o4', provider: 'openai' },
  { prefix: 'chatgpt', provider: 'openai' },

  // DeepSeek
  { prefix: 'deepseek', provider: 'openai' },

  // Qwen (Alibaba)
  { prefix: 'qwen', provider: 'openai' },

  // Meta Llama (via Ollama / Together / etc.)
  { prefix: 'llama', provider: 'openai' },
  { prefix: 'meta-llama', provider: 'openai' },

  // Mistral
  { prefix: 'mistral', provider: 'openai' },
  { prefix: 'mixtral', provider: 'openai' },
  { prefix: 'codestral', provider: 'openai' },

  // Cohere
  { prefix: 'command', provider: 'openai' },

  // Yi
  { prefix: 'yi-', provider: 'openai' },
]

/**
 * Known base URL patterns and their providers.
 */
const URL_PROVIDER_MAP: Array<{ pattern: string; provider: ModelProvider }> = [
  { pattern: 'api.anthropic.com', provider: 'anthropic' },
  { pattern: 'generativelanguage.googleapis.com', provider: 'gemini' },
  { pattern: 'api.openai.com', provider: 'openai' },
  { pattern: 'api.deepseek.com', provider: 'openai' },
  { pattern: 'dashscope.aliyuncs.com', provider: 'openai' },
  { pattern: 'api.together.xyz', provider: 'openai' },
  { pattern: 'api.groq.com', provider: 'openai' },
  { pattern: 'api.fireworks.ai', provider: 'openai' },
  { pattern: 'openrouter.ai', provider: 'openai' },
  { pattern: 'localhost', provider: 'openai' },  // Ollama, LM Studio, etc.
  { pattern: '127.0.0.1', provider: 'openai' },
]

/**
 * Detect the model provider from model name, base URL, or explicit env var.
 */
export function detectProvider(
  modelName: string,
  baseUrl: string,
  explicitMode?: string,
): ModelProvider {
  // 1. Explicit override via env var: MINI_CODE_MODEL_MODE
  if (explicitMode === 'mock') return 'mock'
  if (explicitMode === 'gemini') return 'gemini'
  if (explicitMode === 'anthropic' || explicitMode === 'claude') return 'anthropic'
  if (explicitMode === 'openai') return 'openai'

  const lowerModel = modelName.toLowerCase()

  // 2. Match by model name prefix
  for (const entry of MODEL_PREFIX_MAP) {
    if (lowerModel.startsWith(entry.prefix)) {
      return entry.provider
    }
  }

  // 3. Match by base URL
  const lowerUrl = baseUrl.toLowerCase()
  for (const entry of URL_PROVIDER_MAP) {
    if (lowerUrl.includes(entry.pattern)) {
      return entry.provider
    }
  }

  // 4. Default: OpenAI-compatible (safest fallback — most APIs use this format)
  return 'openai'
}

/**
 * Create the appropriate ModelAdapter based on runtime configuration.
 */
export function createModelAdapter(
  tools: ToolRegistry,
  getRuntimeConfig: () => Promise<RuntimeConfig>,
  runtime: RuntimeConfig | null,
): ModelAdapter {
  const modelMode = process.env.MINI_CODE_MODEL_MODE

  if (modelMode === 'mock') {
    return new MockModelAdapter()
  }

  const modelName = runtime?.model ?? ''
  const baseUrl = runtime?.baseUrl ?? ''
  const provider = detectProvider(modelName, baseUrl, modelMode)

  switch (provider) {
    case 'mock':
      return new MockModelAdapter()
    case 'gemini':
      return new GeminiModelAdapter(tools, getRuntimeConfig)
    case 'anthropic':
      return new AnthropicModelAdapter(tools, getRuntimeConfig)
    case 'openai':
      return new OpenAIModelAdapter(tools, getRuntimeConfig)
  }
}
