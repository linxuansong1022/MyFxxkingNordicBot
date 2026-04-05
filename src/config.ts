import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

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

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>
  sourceSummary: string
}

export type McpConfigScope = 'user' | 'project'

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

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...process.env,
  }

  const model =
    process.env.MINI_CODE_MODEL ||
    effectiveSettings.model ||
    String(env.ANTHROPIC_MODEL ?? '').trim()

  const lowerModel = model.toLowerCase()

  // --- Resolve base URL by provider ---
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

  // --- Resolve auth ---
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined

  // Try all known API key env vars in priority order based on model
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
