import process from 'node:process'
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, ModelAdapter, AgentStep, StepDiagnostics, ToolCall } from './types.js'
import type { RuntimeConfig } from './config.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

// --- Gemini API types ---

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiFunctionDeclaration = {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

type GeminiRequest = {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  generationConfig?: Record<string, unknown>
}

type GeminiCandidate = {
  content?: {
    parts?: GeminiPart[]
    role?: string
  }
  finishReason?: string
}

type GeminiResponse = {
  candidates?: GeminiCandidate[]
  error?: { message?: string; code?: number; status?: string }
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
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

/**
 * Convert JSON Schema `type` values from lowercase (OpenAPI/JSON Schema standard)
 * to uppercase (Gemini API requirement).
 * Also recursively processes nested `properties` and `items`.
 */
function normalizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  if (typeof result.type === 'string') {
    result.type = result.type.toUpperCase()
  }

  if (result.properties && typeof result.properties === 'object') {
    const props = result.properties as Record<string, Record<string, unknown>>
    const normalizedProps: Record<string, Record<string, unknown>> = {}
    for (const [key, value] of Object.entries(props)) {
      normalizedProps[key] = normalizeSchemaForGemini(value)
    }
    result.properties = normalizedProps
  }

  if (result.items && typeof result.items === 'object') {
    result.items = normalizeSchemaForGemini(result.items as Record<string, unknown>)
  }

  // Gemini doesn't support 'additionalProperties' in the same way
  delete result.additionalProperties
  // Gemini doesn't support '$schema'
  delete result.$schema

  return result
}

// --- message conversion ---

function parseProgressMarkers(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  if (!trimmed) {
    return { content: '' }
  }

  const markers: Array<{
    prefix: string
    kind: 'final' | 'progress'
  }> = [
    { prefix: '<final>', kind: 'final' },
    { prefix: '[FINAL]', kind: 'final' },
    { prefix: '<progress>', kind: 'progress' },
    { prefix: '[PROGRESS]', kind: 'progress' },
  ]

  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const rawContent = trimmed.slice(marker.prefix.length).trim()
      const closingTag =
        marker.kind === 'progress'
          ? /<\/progress>/gi
          : /<\/final>/gi
      return {
        content: rawContent.replace(closingTag, '').trim(),
        kind: marker.kind,
      }
    }
  }

  return { content: trimmed }
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string
  contents: GeminiContent[]
} {
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
  const systemInstruction = systemParts.join('\n\n')

  const contents: GeminiContent[] = []

  function pushContent(role: 'user' | 'model', part: GeminiPart): void {
    const last = contents.at(-1)
    if (last?.role === role) {
      last.parts.push(part)
      return
    }
    contents.push({ role, parts: [part] })
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      pushContent('user', { text: msg.content })
      continue
    }

    if (msg.role === 'assistant' || msg.role === 'assistant_progress') {
      const text = msg.role === 'assistant_progress'
        ? `<progress>\n${msg.content}\n</progress>`
        : msg.content
      pushContent('model', { text })
      continue
    }

    if (msg.role === 'assistant_tool_call') {
      pushContent('model', {
        functionCall: {
          name: msg.toolName,
          args: (msg.input as Record<string, unknown>) ?? {},
        },
      })
      continue
    }

    if (msg.role === 'tool_result') {
      pushContent('user', {
        functionResponse: {
          name: msg.toolName,
          response: {
            result: msg.content,
            is_error: msg.isError || undefined,
          },
        },
      })
      continue
    }
  }

  return { systemInstruction, contents }
}

// --- adapter ---

export class GeminiModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const runtime = await this.getRuntimeConfig()
    const { systemInstruction, contents } = toGeminiContents(messages)

    // Resolve model name: strip "gemini/" prefix if present (used by litellm convention)
    const modelName = runtime.model.replace(/^gemini\//, '')

    // Build URL
    const baseUrl = runtime.baseUrl.replace(/\/$/, '')
    const apiKey = runtime.apiKey || ''
    const url = `${baseUrl}/v1beta/models/${modelName}:generateContent?key=${apiKey}`

    // Build tool declarations
    const toolDefs = this.tools.list()
    const functionDeclarations: GeminiFunctionDeclaration[] = toolDefs.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
        ? normalizeSchemaForGemini(tool.inputSchema as Record<string, unknown>)
        : undefined,
    }))

    const requestBody: GeminiRequest = {
      contents,
      ...(systemInstruction
        ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
        : {}),
      ...(functionDeclarations.length > 0
        ? { tools: [{ functionDeclarations }] }
        : {}),
      generationConfig: {
        ...(runtime.maxOutputTokens !== undefined
          ? { maxOutputTokens: runtime.maxOutputTokens }
          : {}),
      },
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    // If using authToken (e.g. Vertex AI), use Bearer auth instead of key param
    if (runtime.authToken) {
      headers.Authorization = `Bearer ${runtime.authToken}`
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
      if (response.ok) {
        break
      }
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
        break
      }
      await sleep(getRetryDelayMs(attempt + 1))
    }

    if (!response) {
      throw new Error('Gemini request failed before receiving a response')
    }

    const data = (await readJsonBody(response)) as GeminiResponse

    if (!response.ok) {
      const errMsg = data.error?.message || `Gemini request failed: ${response.status}`
      throw new Error(errMsg)
    }

    // Parse response
    const candidate = data.candidates?.[0]
    if (!candidate?.content?.parts) {
      // Empty response
      return {
        type: 'assistant',
        content: '',
        diagnostics: { stopReason: candidate?.finishReason },
      }
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const blockTypes: string[] = []

    for (const part of candidate.content.parts) {
      if ('text' in part) {
        blockTypes.push('text')
        textParts.push(part.text)
        continue
      }

      if ('functionCall' in part) {
        blockTypes.push('function_call')
        toolCalls.push({
          id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          toolName: part.functionCall.name,
          input: part.functionCall.args,
        })
        continue
      }
    }

    const parsedText = parseProgressMarkers(textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: candidate.finishReason,
      blockTypes,
    }

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind:
          parsedText.kind === 'progress'
            ? ('progress' as const)
            : undefined,
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
