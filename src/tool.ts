import { z } from 'zod'
import type { PermissionManager } from './permissions.js'
import type { SkillSummary } from './skills.js'
import type { McpServerSummary } from './mcp.js'

export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
}

export type ToolResult = {
  ok: boolean
  output: string
}

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

type ToolRegistryMetadata = {
  skills?: SkillSummary[]
  mcpServers?: McpServerSummary[]
}

export class ToolRegistry {
  constructor(
    private readonly tools: ToolDefinition<unknown>[],
    private readonly metadata: ToolRegistryMetadata = {},
    private readonly disposer?: () => Promise<void>,
  ) {}

  list(): ToolDefinition<unknown>[] {
    return this.tools
  }

  getSkills(): SkillSummary[] {
    return this.metadata.skills ?? []
  }

  getMcpServers(): McpServerSummary[] {
    return this.metadata.mcpServers ?? []
  }

  find(name: string): ToolDefinition<unknown> | undefined {
    return this.tools.find(tool => tool.name === name)
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`,
      }
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }

    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async dispose(): Promise<void> {
    await this.disposer?.()
  }
}
