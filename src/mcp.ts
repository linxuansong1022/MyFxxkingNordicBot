import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { McpServerConfig } from './config.js'
import type { ToolDefinition, ToolResult } from './tool.js'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type McpResourceDescriptor = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

type McpPromptArgument = {
  name: string
  description?: string
  required?: boolean
}

type McpPromptDescriptor = {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export type McpServerSummary = {
  name: string
  command: string
  status: 'connected' | 'error' | 'disabled'
  toolCount: number
  error?: string
  protocol?: JsonRpcProtocol
  resourceCount?: number
  promptCount?: number
}

type JsonRpcProtocol = 'content-length' | 'newline-json'

function sanitizeToolSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool'
  )
}

function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema
  }

  return {
    type: 'object',
    additionalProperties: true,
  }
}

function formatContentBlock(block: unknown): string {
  if (!block || typeof block !== 'object') {
    return JSON.stringify(block, null, 2)
  }

  if ('type' in block && block.type === 'text' && 'text' in block) {
    return String(block.text)
  }

  if ('type' in block && 'resource' in block) {
    return JSON.stringify(block, null, 2)
  }

  return JSON.stringify(block, null, 2)
}

function formatToolCallResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: true,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    content?: unknown[]
    structuredContent?: unknown
    isError?: boolean
  }

  const parts: string[] = []

  if (Array.isArray(typedResult.content) && typedResult.content.length > 0) {
    parts.push(typedResult.content.map(formatContentBlock).join('\n\n'))
  }

  if (typedResult.structuredContent !== undefined) {
    parts.push(
      `STRUCTURED_CONTENT:\n${JSON.stringify(typedResult.structuredContent, null, 2)}`,
    )
  }

  if (parts.length === 0) {
    parts.push(JSON.stringify(result, null, 2))
  }

  return {
    ok: !typedResult.isError,
    output: parts.join('\n\n').trim(),
  }
}

function formatReadResourceResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    contents?: Array<{
      uri?: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }

  const contents = typedResult.contents ?? []
  if (contents.length === 0) {
    return {
      ok: true,
      output: 'No resource contents returned.',
    }
  }

  return {
    ok: true,
    output: contents
      .map(item => {
        const headerLines = [`URI: ${item.uri ?? '(unknown)'}`]
        if (item.mimeType) {
          headerLines.push(`MIME: ${item.mimeType}`)
        }
        const header = `${headerLines.join('\n')}\n\n`

        if (typeof item.text === 'string') {
          return `${header}${item.text}`
        }

        if (typeof item.blob === 'string') {
          return `${header}BLOB:\n${item.blob}`
        }

        return `${header}${JSON.stringify(item, null, 2)}`
      })
      .join('\n\n'),
  }
}

function formatPromptResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    description?: string
    messages?: Array<{
      role?: string
      content?: unknown
    }>
  }

  const header = typedResult.description
    ? `DESCRIPTION: ${typedResult.description}\n\n`
    : ''
  const body = (typedResult.messages ?? [])
    .map(message => {
      const role = message.role ?? 'unknown'
      if (typeof message.content === 'string') {
        return `[${role}]\n${message.content}`
      }
      if (Array.isArray(message.content)) {
        return `[${role}]\n${message.content
          .map(part => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object' && 'text' in part) {
              return String(part.text)
            }
            return JSON.stringify(part, null, 2)
          })
          .join('\n')}`
      }
      return `[${role}]\n${JSON.stringify(message.content, null, 2)}`
    })
    .join('\n\n')

  return {
    ok: true,
    output: `${header}${body}`.trim() || JSON.stringify(result, null, 2),
  }
}

class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private lineBuffer = ''
  private pending = new Map<number, PendingRequest>()
  private stderrLines: string[] = []
  private protocol: JsonRpcProtocol | null = null

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    if (this.process) {
      return
    }

    const protocols = this.getProtocolCandidates()
    let lastError: Error | null = null

    for (const protocol of protocols) {
      try {
        await this.spawnProcess()
        this.protocol = protocol
        await this.request(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'mini-code',
              version: '0.1.0',
            },
          },
          2000,
        )
        this.notify('notifications/initialized', {})
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await this.close()
      }
    }

    throw lastError ?? new Error(`Failed to connect MCP server "${this.serverName}".`)
  }

  getProtocol(): JsonRpcProtocol | null {
    return this.protocol
  }

  getServerName(): string {
    return this.serverName
  }

  private getProtocolCandidates(): JsonRpcProtocol[] {
    if (this.config.protocol === 'content-length') {
      return ['content-length']
    }
    if (this.config.protocol === 'newline-json') {
      return ['newline-json']
    }
    return ['content-length', 'newline-json']
  }

  private async spawnProcess(): Promise<void> {
    const command = this.config.command.trim()
    if (!command) {
      throw new Error(`MCP server "${this.serverName}" has no command configured.`)
    }

    this.buffer = Buffer.alloc(0)
    this.lineBuffer = ''
    this.stderrLines = []
    this.pending.clear()

    const child = spawn(command, this.config.args ?? [], {
      cwd: this.config.cwd ? path.resolve(this.cwd, this.config.cwd) : this.cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(this.config.env ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      },
      stdio: 'pipe',
    })

    this.process = child
    child.stdout.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.handleStdoutChunk(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.stderrLines.push(String(chunk).trim())
      this.stderrLines = this.stderrLines.filter(Boolean).slice(-8)
    })
    child.on('exit', code => {
      if (this.process !== child) {
        return
      }
      const error = new Error(
        `MCP server "${this.serverName}" exited with code ${code ?? 'unknown'}${
          this.stderrLines.length > 0
            ? `\n${this.stderrLines.join('\n')}`
            : ''
        }`,
      )
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
      this.process = null
    })
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDescriptor[]
    }
    return result.tools ?? []
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {}, 3000)) as {
      resources?: McpResourceDescriptor[]
    }
    return result.resources ?? []
  }

  async readResource(uri: string): Promise<ToolResult> {
    const result = await this.request('resources/read', { uri }, 5000)
    return formatReadResourceResult(result)
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {}, 3000)) as {
      prompts?: McpPromptDescriptor[]
    }
    return result.prompts ?? []
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const result = await this.request(
      'prompts/get',
      {
        name,
        arguments: args ?? {},
      },
      5000,
    )
    return formatPromptResult(result)
  }

  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: input ?? {},
    })
    return formatToolCallResult(result)
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(
        new Error(`MCP server "${this.serverName}" closed before completing the request.`),
      )
    }
    this.pending.clear()

    if (!this.process) {
      this.protocol = null
      return
    }

    this.process.kill()
    this.process = null
    this.protocol = null
  }

  private notify(method: string, params: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = 5000,
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `MCP ${this.serverName}: request timed out for ${method}${
              this.stderrLines.length > 0 ? `\n${this.stderrLines.join('\n')}` : ''
            }`,
          ),
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })
    })
  }

  private send(message: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error(`MCP server "${this.serverName}" is not running.`)
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    if (this.protocol === 'newline-json') {
      this.process.stdin.write(`${body.toString('utf8')}\n`)
      return
    }

    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
    this.process.stdin.write(Buffer.concat([header, body]))
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.protocol === 'newline-json') {
      this.handleStdoutChunkAsLines(chunk)
      return
    }

    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      const separatorIndex = this.buffer.indexOf('\r\n\r\n')
      if (separatorIndex === -1) {
        return
      }

      const headerText = this.buffer
        .subarray(0, separatorIndex)
        .toString('utf8')
      const headers = headerText.split('\r\n')
      const contentLengthHeader = headers.find(line =>
        line.toLowerCase().startsWith('content-length:'),
      )
      if (!contentLengthHeader) {
        this.buffer = this.buffer.subarray(separatorIndex + 4)
        continue
      }

      const contentLength = Number(contentLengthHeader.split(':')[1]?.trim() ?? 0)
      const bodyStart = separatorIndex + 4
      const bodyEnd = bodyStart + contentLength

      if (this.buffer.length < bodyEnd) {
        return
      }

      const payload = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.buffer = this.buffer.subarray(bodyEnd)
      this.handleMessage(JSON.parse(payload) as JsonRpcMessage)
    }
  }

  private handleStdoutChunkAsLines(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8')

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const rawLine = this.lineBuffer.slice(0, newlineIndex)
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      this.handleMessage(JSON.parse(line) as JsonRpcMessage)
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id !== 'number') {
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }

    this.pending.delete(message.id)
    clearTimeout(pending.timeout)

    if (message.error) {
      pending.reject(
        new Error(
          `MCP ${this.serverName}: ${message.error.message}${
            message.error.data ? `\n${JSON.stringify(message.error.data, null, 2)}` : ''
          }`,
        ),
      )
      return
    }

    pending.resolve(message.result)
  }
}

export async function createMcpBackedTools(args: {
  cwd: string
  mcpServers: Record<string, McpServerConfig>
}): Promise<{
  tools: ToolDefinition<unknown>[]
  servers: McpServerSummary[]
  dispose: () => Promise<void>
}> {
  const clients: StdioMcpClient[] = []
  const tools: ToolDefinition<unknown>[] = []
  const servers: McpServerSummary[] = []
  const resourceIndex = new Map<string, { serverName: string; resource: McpResourceDescriptor }>()
  const promptIndex = new Map<string, { serverName: string; prompt: McpPromptDescriptor }>()

  for (const [serverName, config] of Object.entries(args.mcpServers)) {
    if (config.enabled === false) {
      servers.push({
        name: serverName,
        command: config.command,
        status: 'disabled',
        toolCount: 0,
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
      continue
    }

    const client = new StdioMcpClient(serverName, config, args.cwd)

    try {
      await client.start()
      const descriptors = await client.listTools()
      const resources = await client.listResources().catch(() => [])
      const prompts = await client.listPrompts().catch(() => [])
      clients.push(client)

      for (const resource of resources) {
        resourceIndex.set(`${serverName}:${resource.uri}`, {
          serverName,
          resource,
        })
      }

      for (const prompt of prompts) {
        promptIndex.set(`${serverName}:${prompt.name}`, {
          serverName,
          prompt,
        })
      }

      for (const descriptor of descriptors) {
        const wrappedName = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(
          descriptor.name,
        )}`
        const inputSchema = normalizeInputSchema(descriptor.inputSchema)
        tools.push({
          name: wrappedName,
          description:
            descriptor.description?.trim() ||
            `Call MCP tool ${descriptor.name} from server ${serverName}.`,
          inputSchema,
          schema: z.unknown(),
          async run(input) {
            return client.callTool(descriptor.name, input)
          },
        })
      }

      servers.push({
        name: serverName,
        command: config.command,
        status: 'connected',
        toolCount: descriptors.length,
        protocol: client.getProtocol() ?? undefined,
        resourceCount: resources.length,
        promptCount: prompts.length,
      })
    } catch (error) {
      await client.close()
      servers.push({
        name: serverName,
        command: config.command,
        status: 'error',
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
    }
  }

  if (resourceIndex.size > 0) {
    tools.push({
      name: 'list_mcp_resources',
      description: 'List available MCP resources exposed by connected MCP servers.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const lines = [...resourceIndex.values()]
          .filter(entry => !input.server || entry.serverName === input.server)
          .map(
            entry =>
              `${entry.serverName}: ${entry.resource.uri}${entry.resource.name ? ` (${entry.resource.name})` : ''}${entry.resource.description ? ` - ${entry.resource.description}` : ''}`,
          )
        return {
          ok: true,
          output: lines.length > 0 ? lines.join('\n') : 'No MCP resources available.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'read_mcp_resource',
      description: 'Read a specific MCP resource by server and URI.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          uri: { type: 'string' },
        },
        required: ['server', 'uri'],
      },
      schema: z.object({
        server: z.string().min(1),
        uri: z.string().min(1),
      }),
      async run(input: { server: string; uri: string }) {
        const client = clients.find(item => item.getServerName() === input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.readResource(input.uri)
      },
    } satisfies ToolDefinition<{ server: string; uri: string }>)
  }

  if (promptIndex.size > 0) {
    tools.push({
      name: 'list_mcp_prompts',
      description: 'List available MCP prompts exposed by connected MCP servers.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const lines = [...promptIndex.values()]
          .filter(entry => !input.server || entry.serverName === input.server)
          .map(entry => {
            const argsSummary = (entry.prompt.arguments ?? [])
              .map(arg => `${arg.name}${arg.required ? '*' : ''}`)
              .join(', ')
            return `${entry.serverName}: ${entry.prompt.name}${argsSummary ? ` args=[${argsSummary}]` : ''}${entry.prompt.description ? ` - ${entry.prompt.description}` : ''}`
          })
        return {
          ok: true,
          output: lines.length > 0 ? lines.join('\n') : 'No MCP prompts available.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'get_mcp_prompt',
      description: 'Fetch a rendered MCP prompt by server, prompt name, and optional arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          name: { type: 'string' },
          arguments: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['server', 'name'],
      },
      schema: z.object({
        server: z.string().min(1),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.string()).optional(),
      }),
      async run(input: {
        server: string
        name: string
        arguments?: Record<string, string>
      }) {
        const client = clients.find(item => item.getServerName() === input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.getPrompt(input.name, input.arguments)
      },
    } satisfies ToolDefinition<{
      server: string
      name: string
      arguments?: Record<string, string>
    }>)
  }

  return {
    tools,
    servers,
    async dispose() {
      await Promise.all(clients.map(client => client.close()))
    },
  }
}
