// gemini-adapter.ts
// 职责：实现 ModelAdapter 接口，把项目内部格式翻译成 Gemini API 格式，发请求，再翻译回来
//
// 核心流程：
//   ChatMessage[]（内部格式）
//     ↓ toGeminiContents() 翻译
//   Gemini API 请求（contents + systemInstruction + tools）
//     ↓ fetch 发出去
//   Gemini API 响应（candidates[0].content.parts）
//     ↓ 解析
//   AgentStep（内部格式）—— 还给 agent-loop

import process from 'node:process'
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, ModelAdapter, AgentStep, StepDiagnostics, ToolCall } from './types.js'
import type { RuntimeConfig } from './config.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

// --- Gemini API 的数据类型定义 ---
// 这些类型对应 Gemini REST API 的 JSON 结构，不是项目内部格式
// 理解这里就理解了"为什么需要翻译"——两套格式完全不同

// Gemini 的"内容块"：文本 / 函数调用 / 函数结果，三选一
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

// Gemini 的消息单元：role + 若干 parts
// 注意：Gemini 只有 'user' 和 'model' 两种 role（不像内部有 assistant_tool_call 等细分）
type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiFunctionDeclaration = {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

// Gemini 请求体的完整结构
// 关键字段：contents（对话历史）、systemInstruction（system prompt 单独放这里）、tools（工具声明）
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

// --- 工具函数 ---

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

// 429（限流）和 5xx（服务端错误）才重试，4xx 客户端错误不重试
function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// 指数退避：每次重试等待时间翻倍，加随机抖动避免多客户端同时重试
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

// Gemini 要求 JSON Schema 里的 type 值必须大写（STRING / NUMBER / OBJECT）
// 标准 JSON Schema 是小写，所以需要递归转换
// 同时删掉 Gemini 不支持的字段（additionalProperties / $schema）
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

// --- 消息格式翻译（最重要的函数）---

// 解析 <progress> / <final> 标记，提取实际内容和类型
// 这对应 prompt.ts 里定义的"结构化响应协议"
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

// ★★★ 核心翻译函数 ★★★
//
// 把项目内部的 ChatMessage[] 翻译成 Gemini API 要求的格式
//
// 关键差异：
//   内部格式有 7 种 role（system / user / assistant / assistant_progress / assistant_tool_call / tool_result / context_summary）
//   Gemini 只认 2 种 role（user / model）
//
// 翻译规则：
//   system          → 单独提取，放进 systemInstruction（不进 contents）
//   user            → user role，text part
//   assistant       → model role，text part
//   assistant_progress → model role，text part（加 <progress> 包裹，告知模型这是中间状态）
//   assistant_tool_call → model role，functionCall part
//   tool_result     → user role，functionResponse part
//
// 另外：相邻同 role 的消息会被合并到同一个 GeminiContent 里（pushContent 函数负责这个）
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string
  contents: GeminiContent[]
} {
  // system 消息单独提取，不进 contents 数组
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
  const systemInstruction = systemParts.join('\n\n')

  const contents: GeminiContent[] = []

  // 相邻同 role 的消息合并到同一个 GeminiContent（Gemini 要求不能连续两条同 role）
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

    // 工具调用：翻译成 Gemini 的 functionCall 格式
    if (msg.role === 'assistant_tool_call') {
      pushContent('model', {
        functionCall: {
          name: msg.toolName,
          args: (msg.input as Record<string, unknown>) ?? {},
        },
      })
      continue
    }

    // 工具结果：翻译成 Gemini 的 functionResponse 格式，放在 user 侧
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

// --- 适配器主体 ---

// 实现 ModelAdapter 接口，这是 agent-loop 唯一调用的入口
// agent-loop 只知道"有个东西实现了 next(messages)"，完全不关心这里是 Gemini 还是别的
export class GeminiModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const runtime = await this.getRuntimeConfig()

    // 1. 翻译消息格式
    const { systemInstruction, contents } = toGeminiContents(messages)

    // 去掉 "gemini/" 前缀（LiteLLM 等代理服务常用这个约定）
    const modelName = runtime.model.replace(/^gemini\//, '')

    // 2. 构建请求 URL（用 key 作为 query 参数是 Gemini 的认证方式）
    const baseUrl = runtime.baseUrl.replace(/\/$/, '')
    const apiKey = runtime.apiKey || ''
    const url = `${baseUrl}/v1beta/models/${modelName}:generateContent?key=${apiKey}`

    // 3. 把 ToolRegistry 里的工具翻译成 Gemini 的 functionDeclarations 格式
    // 这样 Gemini 才知道它能调哪些工具
    const toolDefs = this.tools.list()
    const functionDeclarations: GeminiFunctionDeclaration[] = toolDefs.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
        ? normalizeSchemaForGemini(tool.inputSchema as Record<string, unknown>)
        : undefined,
    }))

    // 4. 组装完整请求体
    const requestBody: GeminiRequest = {
      contents,
      // system prompt 单独放 systemInstruction，不混进 contents
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

    // Bearer token 认证（Vertex AI 用，和 key 认证二选一）
    if (runtime.authToken) {
      headers.Authorization = `Bearer ${runtime.authToken}`
    }

    // 5. 带重试发请求（429 限流 / 5xx 服务端错误 → 等一等再试）
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

    // 6. 解析响应 → 翻译回 AgentStep
    const candidate = data.candidates?.[0]
    if (!candidate?.content?.parts) {
      // 空响应（通常是 safety filter 触发了，模型拒绝回答）
      return {
        type: 'assistant',
        content: '',
        diagnostics: { stopReason: candidate?.finishReason },
      }
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const blockTypes: string[] = []

    // Gemini 的 parts 数组里可能混有文本和函数调用，分别提取
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

    // ★ 关键判断：有工具调用 → tool_calls 类型（agent-loop 会去执行工具）
    //             没有工具调用 → assistant 类型（agent-loop 会检查是否结束）
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
