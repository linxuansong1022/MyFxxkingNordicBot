import process from 'node:process'
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, ModelAdapter, AgentStep, StepDiagnostics, ToolCall } from './types.js'
import type { RuntimeConfig } from './config.js'
import { recordUsage } from './usage-tracker.js'

/**
 * OpenAI Chat Completions API adapter.
 *
 * Works with any provider exposing the /v1/chat/completions endpoint:
 *   - OpenAI (GPT-4o, GPT-4, etc.)
 *   - DeepSeek
 *   - Qwen (Alibaba)
 *   - Ollama (local)
 *   - Together AI, Groq, Fireworks, OpenRouter, etc.
 */

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

// --- OpenAI API types ---

type OpenAIFunctionDef = {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

type OpenAITool = {
  type: 'function'
  function: OpenAIFunctionDef
}

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIChoice = {
  message: {
    role: string
    content?: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason?: string
}

type OpenAIResponse = {
  choices?: OpenAIChoice[]
  error?: { message?: string; code?: string }
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

// --- helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

function getRetryLimit(): number {
  const value = Number(process.env.MINI_CODE_MAX_RETRIES)
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RETRIES
  }
  return Math.floor(value)
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function getRetryDelayMs(attempt: number): number {
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    MAX_RETRY_DELAY_MS,
  )
  const jitter = Math.random() * 0.25 * base
  return Math.floor(base + jitter)
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

// --- progress markers (shared protocol) ---

function parseProgressMarkers(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  if (!trimmed) return { content: '' }

  const markers: Array<{ prefix: string; kind: 'final' | 'progress' }> = [
    { prefix: '<final>', kind: 'final' },
    { prefix: '[FINAL]', kind: 'final' },
    { prefix: '<progress>', kind: 'progress' },
    { prefix: '[PROGRESS]', kind: 'progress' },
  ]

  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const rawContent = trimmed.slice(marker.prefix.length).trim()
      const closingTag =
        marker.kind === 'progress' ? /<\/progress>/gi : /<\/final>/gi
      return {
        content: rawContent.replace(closingTag, '').trim(),
        kind: marker.kind,
      }
    }
  }

  return { content: trimmed }
}

// --- message conversion ---

function toOpenAIMessages(messages: ChatMessage[]): {
  systemMessage: string
  openaiMessages: OpenAIMessage[]
} {
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
  const systemMessage = systemParts.join('\n\n')

  const openaiMessages: OpenAIMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      openaiMessages.push({ role: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'assistant' || msg.role === 'assistant_progress') {
      const text =
        msg.role === 'assistant_progress'
          ? `<progress>\n${msg.content}\n</progress>`
          : msg.content
      openaiMessages.push({ role: 'assistant', content: text })
      continue
    }

    if (msg.role === 'assistant_tool_call') {
      // OpenAI groups tool_calls inside the assistant message
      const lastMsg = openaiMessages.at(-1)
      const toolCall: OpenAIToolCall = {
        id: msg.toolUseId,
        type: 'function',
        function: {
          name: msg.toolName,
          arguments: JSON.stringify(msg.input ?? {}),
        },
      }

      if (lastMsg?.role === 'assistant') {
        // Append to existing assistant message
        if (!lastMsg.tool_calls) {
          lastMsg.tool_calls = []
        }
        lastMsg.tool_calls.push(toolCall)
      } else {
        // Create a new assistant message with tool_calls
        openaiMessages.push({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        })
      }
      continue
    }

    if (msg.role === 'tool_result') {
      const content = msg.isError ? `ERROR: ${msg.content}` : msg.content
      openaiMessages.push({
        role: 'tool',
        tool_call_id: msg.toolUseId,
        content,
      })
      continue
    }
  }

  return { systemMessage, openaiMessages }
}

// --- adapter ---

export class OpenAIModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const runtime = await this.getRuntimeConfig()
    const { systemMessage, openaiMessages } = toOpenAIMessages(messages)

    // Build URL
    const baseUrl = runtime.baseUrl.replace(/\/$/, '')
    const url = `${baseUrl}/v1/chat/completions`

    // Build tool definitions
    const toolDefs = this.tools.list()
    const tools: OpenAITool[] = toolDefs.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown> | undefined,
      },
    }))

    const requestBody = {
      model: runtime.model,
      messages: [
        { role: 'system', content: systemMessage },
        ...openaiMessages,
      ],
      ...(tools.length > 0 ? { tools } : {}),
      ...(runtime.maxOutputTokens !== undefined
        ? { max_tokens: runtime.maxOutputTokens }
        : {}),
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    // Auth: Bearer token (most OpenAI-compatible APIs)
    const authKey = runtime.authToken || runtime.apiKey
    if (authKey) {
      headers.Authorization = `Bearer ${authKey}`
    }

    // Retry loop
    const maxRetries = getRetryLimit()
    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      })
      if (response.ok) break
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) break
      await sleep(getRetryDelayMs(attempt + 1))
    }

    if (!response) {
      throw new Error('OpenAI-compatible request failed before receiving a response')
    }

    const data = (await readJsonBody(response)) as OpenAIResponse

    if (!response.ok) {
      const errMsg = data.error?.message || `Request failed: ${response.status}`
      throw new Error(errMsg)
    }

    // 把账单（usage）写进 tracker，给 /cost 命令读。
    // OpenAI 的 prompt_tokens 已经包含 cached_tokens（是前者的子集），
    // 对齐 tracker 的 uncachedInput = inputTokens - cachedTokens 公式。
    // reasoning token（o1/o3）已经内含在 completion_tokens 里，不需要单独加。
    if (data.usage) {
      const usage = data.usage
      recordUsage({
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        model: data.model ?? runtime.model,
      })
    }

    // Parse response
    const choice = data.choices?.[0]
    if (!choice?.message) {
      return {
        type: 'assistant',
        content: '',
        diagnostics: { stopReason: choice?.finish_reason },
      }
    }

    const assistantMsg = choice.message
    const toolCalls: ToolCall[] = []
    const blockTypes: string[] = []

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        blockTypes.push('function_call')
        let parsedArgs: unknown = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments)
        } catch {
          parsedArgs = {}
        }
        toolCalls.push({
          id: tc.id,
          toolName: tc.function.name,
          input: parsedArgs,
        })
      }
    }

    if (assistantMsg.content) {
      blockTypes.push('text')
    }

    const textContent = assistantMsg.content ?? ''
    const parsedText = parseProgressMarkers(textContent)
    const diagnostics: StepDiagnostics = {
      stopReason: choice.finish_reason,
      blockTypes,
    }

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind:
          parsedText.kind === 'progress' ? ('progress' as const) : undefined,
        diagnostics,
      }
    }

    return {
      type: 'assistant',
      content: parsedText.content,
      kind: parsedText.kind,
      diagnostics,
    }
  }
}
