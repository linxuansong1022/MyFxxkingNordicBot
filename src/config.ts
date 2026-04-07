// config.ts
// 职责：把分散在多个文件 + 环境变量里的配置，合并成一个统一的 RuntimeConfig 对象
//
// 核心思想：多层配置合并 + 优先级覆盖
// 配置来源（从低到高）：
//   1. ~/.claude/settings.json          （Claude Code 的全局设置，兼容用）
//   2. ~/.mini-code/mcp.json             （全局 MCP 服务器列表）
//   3. ./.mcp.json                       （项目级 MCP 服务器列表）
//   4. ~/.mini-code/settings.json        （本项目的全局设置：模型、API key 等）
//   5. process.env                       （环境变量，最高优先级）
//
// 后面的来源覆盖前面的，跟 CLAUDE.md 的"项目覆盖全局"是同一个思路：
// 越具体的配置越优先。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

// 用户写在 settings.json 里的原始格式（部分字段可选）
export type MiniCodeSettings = {
  env?: Record<string, string | number>
  model?: string
  maxOutputTokens?: number
  mcpServers?: Record<string, McpServerConfig>
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
}

// 整个项目运行时的"圣经"：所有 adapter / 工具 / 权限系统都拿这个对象做决策
// 这是 loadRuntimeConfig() 的最终输出，所有合并、覆盖、兜底都已经处理完了
export type RuntimeConfig = {
  model: string                                // 用哪个模型（决定调用哪家 adapter）
  baseUrl: string                              // API 端点
  authToken?: string                           // Bearer token（Claude / Vertex AI 用）
  apiKey?: string                              // API key（Gemini / OpenAI 等用）
  maxOutputTokens?: number                     // 单次响应的最大 token 数
  mcpServers: Record<string, McpServerConfig>  // 已合并的 MCP 服务器列表
  sourceSummary: string                        // 配置来源说明（用于调试）
}

export type McpConfigScope = 'user' | 'project'

// 所有配置文件的路径常量
// 用 os.homedir() 而不是写死 → 跨用户、跨平台可用（与 prompt.ts 同一思路）
export const MINI_CODE_DIR = path.join(os.homedir(), '.mini-code')
export const MINI_CODE_SETTINGS_PATH = path.join(MINI_CODE_DIR, 'settings.json')
export const MINI_CODE_HISTORY_PATH = path.join(MINI_CODE_DIR, 'history.json')
export const MINI_CODE_PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')
export const MINI_CODE_MCP_PATH = path.join(MINI_CODE_DIR, 'mcp.json')
export const MINI_CODE_MCP_TOKENS_PATH = path.join(MINI_CODE_DIR, 'mcp-tokens.json')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')

export async function readMcpTokensFile(
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

// 安全读取 settings 文件：文件不存在时返回空对象，不抛异常
// 跟 prompt.ts 的 maybeRead 是同一个套路：把"可选文件"的不存在翻译成"空值"
// 但注意：只兜底 ENOENT（文件不存在），其他错误（权限、JSON 损坏）仍然抛出
async function readSettingsFile(filePath: string): Promise<MiniCodeSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as MiniCodeSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : MINI_CODE_MCP_PATH
}

export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

// === 配置合并的核心函数 ===
//
// 把两份 settings 合并成一份，override 覆盖 base
// 但"覆盖"不是粗暴地整个替换，而是分字段做深合并：
//   - 普通字段（model 等）：override 覆盖 base
//   - env：两份合并，override 的 key 覆盖 base 的 key
//   - mcpServers：按服务器名称合并，同名服务器的 env / headers 也分别深合并
//
// 为什么要深合并：用户可能在全局配了 MCP 服务器 A 的基础参数，
// 在项目级只想加一个环境变量，而不是把整个 A 重写一遍。
function mergeSettings(
  base: MiniCodeSettings,
  override: MiniCodeSettings,
): MiniCodeSettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
  }
}

// === 多层配置加载入口 ===
//
// 把 4 个来源的配置文件按顺序合并成一份"有效设置"
// 关键点：
//   1. 用 Promise.all 并行读取 4 个文件（IO 不互相依赖，能并行就并行）
//   2. 用嵌套 mergeSettings 体现优先级：越外层调用 = 优先级越高
//
// 优先级（从低到高）：
//   claudeSettings  →  globalMcpConfig  →  projectMcpConfig  →  miniCodeSettings
//
// 注意：环境变量还没参与合并，那一层在 loadRuntimeConfig 里处理
export async function loadEffectiveSettings(): Promise<MiniCodeSettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, miniCodeSettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(MINI_CODE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(MINI_CODE_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    miniCodeSettings,
  )
}

export async function saveMiniCodeSettings(
  updates: MiniCodeSettings,
): Promise<void> {
  await mkdir(MINI_CODE_DIR, { recursive: true })
  const existing = await readSettingsFile(MINI_CODE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    MINI_CODE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

// === 整个 config.ts 的最终入口 ===
//
// 这是 index.ts 启动时调用的函数，输出整个项目运行所需的全部配置
//
// 流程：
//   1. 加载并合并 4 个文件（loadEffectiveSettings）
//   2. 把 process.env 叠加到 env 上（环境变量优先级最高）
//   3. 解析模型名称 → 推断 baseUrl → 推断要用哪个 API key
//   4. 兜底校验：没有 model 或 key 就抛错（让用户立刻看到问题，而不是跑到一半失败）
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()

  // env 合并：settings 文件里的 env 在前，process.env 在后
  // → 环境变量永远覆盖文件配置，方便 CI/临时调试时覆盖
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...process.env,
  }

  const model =
    process.env.MINI_CODE_MODEL ||
    effectiveSettings.model ||
    String(env.ANTHROPIC_MODEL ?? '').trim()

  const lowerModel = model.toLowerCase()

  // === 根据模型名前缀推断 baseUrl ===
  // 关键设计：用户只需要写 model 名，系统自动选对应的 API 端点
  // 例如 model="gemini-2.5-flash" → baseUrl 自动用 Google 的端点
  //      model="claude-opus-4"     → baseUrl 自动用 Anthropic 的端点
  // 用户也可以用环境变量手动指定，覆盖默认值（最常见的场景：本地 Ollama / LiteLLM 代理）
  const explicitBaseUrl = String(env.ANTHROPIC_BASE_URL ?? '').trim()
  let defaultBaseUrl: string

  if (lowerModel.startsWith('gemini')) {
    defaultBaseUrl = String(env.GEMINI_BASE_URL ?? '').trim() || 'https://generativelanguage.googleapis.com'
  } else if (lowerModel.startsWith('deepseek')) {
    defaultBaseUrl = String(env.DEEPSEEK_BASE_URL ?? '').trim() || 'https://api.deepseek.com'
  } else if (lowerModel.startsWith('qwen')) {
    defaultBaseUrl = String(env.QWEN_BASE_URL ?? '').trim() || 'https://dashscope.aliyuncs.com/compatible-mode'
  } else if (lowerModel.startsWith('gpt') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3') || lowerModel.startsWith('o4') || lowerModel.startsWith('chatgpt')) {
    defaultBaseUrl = String(env.OPENAI_BASE_URL ?? '').trim() || 'https://api.openai.com'
  } else if (lowerModel.startsWith('claude')) {
    defaultBaseUrl = 'https://api.anthropic.com'
  } else {
    // Unknown model — if OPENAI_BASE_URL is set, use it (likely Ollama/local)
    defaultBaseUrl = String(env.OPENAI_BASE_URL ?? '').trim() || 'https://api.openai.com'
  }

  const baseUrl = explicitBaseUrl || defaultBaseUrl

  // === 解析认证信息 ===
  // 两种认证方式：
  //   - authToken: Bearer token（Anthropic 官方 / Vertex AI 用）
  //   - apiKey:    URL query 参数 / header（其他模型用）
  // 适配器会根据模型自己选用哪个
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined

  // 按顺序尝试所有已知的 API key 环境变量名
  // 用 || 短路：第一个非空的就用
  // 这样用户配哪个都行，不用强制规定环境变量名
  const apiKey =
    String(env.ANTHROPIC_API_KEY ?? '').trim() ||
    String(env.GEMINI_API_KEY ?? '').trim() ||
    String(env.OPENAI_API_KEY ?? '').trim() ||
    String(env.DEEPSEEK_API_KEY ?? '').trim() ||
    undefined

  const rawMaxOutputTokens =
    process.env.MINI_CODE_MAX_OUTPUT_TOKENS ??
    effectiveSettings.maxOutputTokens ??
    env.MINI_CODE_MAX_OUTPUT_TOKENS
  const parsedMaxOutputTokens =
    rawMaxOutputTokens === undefined ? NaN : Number(rawMaxOutputTokens)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  // === Fail-fast 校验 ===
  // 没有 model 或 key 直接抛错，让用户在启动时就看到问题
  // 而不是跑到第一次调 LLM 才失败（那种错更难定位）
  if (!model) {
    throw new Error(
      `No model configured. Set "model" in ~/.mini-code/settings.json.`,
    )
  }

  if (!authToken && !apiKey) {
    throw new Error(
      `No API key configured. Set the matching key in ~/.mini-code/settings.json under "env".\n` +
      `  Gemini  → GEMINI_API_KEY\n` +
      `  Claude  → ANTHROPIC_API_KEY\n` +
      `  OpenAI  → OPENAI_API_KEY\n` +
      `  DeepSeek→ DEEPSEEK_API_KEY`,
    )
  }

  return {
    model,
    baseUrl,
    authToken,
    apiKey,
    maxOutputTokens,
    mcpServers: effectiveSettings.mcpServers ?? {},
    sourceSummary: `config: ${MINI_CODE_SETTINGS_PATH} > ${CLAUDE_SETTINGS_PATH} > process.env`,
  }
}
