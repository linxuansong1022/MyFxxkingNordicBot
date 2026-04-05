import { z } from 'zod'
import type { PermissionManager } from './permissions.js'
import type { SkillSummary } from './skills.js'
import type { McpServerSummary } from './mcp.js'

// ToolContext 是工具运行时可拿到的环境信息。
// 例如当前目录 cwd，以及可选的权限管理器。
export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
}

// 有些命令不会立刻结束，而是放到后台执行。
// 这种类型用来描述后台任务的状态。
export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: 'running' | 'completed' | 'failed'
  startedAt: number
}

// ToolResult 是工具执行后的统一返回格式。
// ok 表示成功/失败，output 是给模型看的文本结果。
export type ToolResult = {
  ok: boolean
  output: string
  backgroundTask?: BackgroundTaskResult
  awaitUser?: boolean
}

// ToolDefinition 是“一个工具应该长什么样”的模板。
// TInput 表示这个工具自己的输入参数类型。
export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

// 这里只是 ToolRegistry 内部自己使用的元数据，所以没有 export。
type ToolRegistryMetadata = {
  skills?: SkillSummary[]
  mcpServers?: McpServerSummary[]
}

// ToolRegistry 是工具注册表。
// 你可以把它理解成“管理所有工具的总入口”。
export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private metadataStore: ToolRegistryMetadata
  private readonly disposers: Array<() => Promise<void>> = []

  constructor(
    tools: ToolDefinition<unknown>[],
    metadata: ToolRegistryMetadata = {},
    disposer?: () => Promise<void>,
  ) {
    this.toolsStore = [...tools]
    this.metadataStore = metadata
    if (disposer) {
      this.disposers.push(disposer)
    }
  }

  // 返回当前已注册的所有工具。
  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  // 返回已加载的 skills 元数据。
  getSkills(): SkillSummary[] {
    return this.metadataStore.skills ?? []
  }

  // 返回已连接的 MCP server 元数据。
  getMcpServers(): McpServerSummary[] {
    return this.metadataStore.mcpServers ?? []
  }

  // 更新 MCP server 元数据。
  setMcpServers(servers: McpServerSummary[]): void {
    this.metadataStore = {
      ...this.metadataStore,
      mcpServers: [...servers],
    }
  }

  // 添加新工具；如果名字重复则跳过，避免重复注册。
  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(tool => tool.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) {
        continue
      }
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  // 注册清理函数，程序结束时统一 dispose。
  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer)
  }

  // 根据名字查找工具。
  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }

  // execute 是工具系统最关键的方法：
  // 1. 先按名字找工具
  // 2. 再校验输入参数
  // 3. 最后执行工具的 run()
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

    // 用 zod schema 校验输入，防止模型传错参数。
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

  // 统一执行所有清理函数。
  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}
