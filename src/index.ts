/**
 * ====================================================================
 * index.ts — 程序入口，把所有模块串起来
 * ====================================================================
 *
 * 这个文件做的事情：
 *   1. 加载配置（settings.json）
 *   2. 注册工具（read_file、run_command 等）
 *   3. 创建模型适配器（Gemini/Claude/GPT，根据配置自动选）
 *   4. 构建初始消息（system prompt）
 *   5. 启动 UI（交互终端 → TUI 模式，管道输入 → 简单模式）
 *
 * 启动流程图：
 *
 *   npm run dev
 *       ↓
 *   main()
 *       ↓
 *   loadRuntimeConfig()  → 读 ~/.mini-code/settings.json
 *       ↓
 *   createDefaultToolRegistry()  → 注册 13 个工具
 *       ↓
 *   createModelAdapter()  → 根据 model 名自动选适配器
 *       ↓
 *   buildSystemPrompt()  → 构建 system 消息
 *       ↓
 *   是交互终端？
 *     ├─ 是 → runTtyApp()    （全屏 TUI 界面）
 *     └─ 否 → readline 循环  （简单的一问一答模式）
 */

import readline from 'node:readline'
import process from 'node:process'
import {
  completeSlashCommand,
  findMatchingSlashCommands,
  tryHandleLocalCommand,
} from './cli-commands.js'
import { loadRuntimeConfig } from './config.js'
import { maybeHandleManagementCommand } from './manage-cli.js'
import { summarizeMcpServers } from './mcp-status.js'
import { createModelAdapter } from './model-factory.js'
import { PermissionManager } from './permissions.js'
import { buildSystemPrompt } from './prompt.js'
import { createDefaultToolRegistry, hydrateMcpTools } from './tools/index.js'
import type { ChatMessage } from './types.js'
import { renderBanner } from './ui.js'
import { runTtyApp } from './tty-app.js'
import { runAgentTurn } from './agent-loop.js'
import { beginTurn as beginUsageTurn } from './usage-tracker.js'

async function main(): Promise<void> {
  // 获取当前工作目录（用户在哪个文件夹下运行的这个程序）
  const cwd = process.cwd()

  // 获取命令行参数（如 `minicode config set model gemini-2.5-flash`）
  const argv = process.argv.slice(2)

  // 检查是否是管理命令（config、install 等），如果是就执行完直接退出
  if (await maybeHandleManagementCommand(cwd, argv)) {
    return
  }

  // =================================================================
  // 第 1 步：加载配置
  // =================================================================
  // 判断是否在交互终端中运行（vs 管道输入如 echo "xxx" | minicode）
  const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  // 加载 ~/.mini-code/settings.json 中的配置
  // 包含：model 名称、API key、base URL 等
  // 如果加载失败就设为 null，后面会用默认值
  let runtime = null
  try {
    runtime = await loadRuntimeConfig()
  } catch {
    runtime = null
  }

  // =================================================================
  // 第 2 步：注册工具
  // =================================================================
  // 创建工具注册表，注册所有内置工具（read_file、write_file、run_command 等）
  const tools = await createDefaultToolRegistry({
    cwd,
    runtime,
  })

  // 异步加载 MCP 工具（外部工具服务器），不阻塞启动
  // 即使 MCP 连接失败也不影响主程序
  const mcpHydration = hydrateMcpTools({
    cwd,
    runtime,
    tools,
  }).catch(() => {
    // Keep startup resilient even if some MCP servers fail.
  })

  // =================================================================
  // 第 3 步：初始化权限管理 + 模型适配器
  // =================================================================
  // 权限管理器：控制工具执行时是否需要用户审批
  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()

  // 根据 settings.json 中的 model 名称，自动创建对应的适配器
  // gemini-* → GeminiAdapter, claude-* → AnthropicAdapter, gpt-* → OpenAIAdapter
  const model = createModelAdapter(tools, loadRuntimeConfig, runtime)

  // =================================================================
  // 第 4 步：构建初始消息数组
  // =================================================================
  // messages 是整个对话的核心数据结构
  // 初始时只有一条 system 消息，告诉 AI 它是谁、能做什么
  let messages: ChatMessage[] = [
    {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers(),
      }),
    },
  ]

  /**
   * 刷新 system prompt。
   * 为什么需要刷新？因为 MCP 工具可能在启动后才连接成功，
   * 刷新后 AI 就能知道有新工具可用了。
   */
  async function refreshSystemPrompt(): Promise<void> {
    messages[0] = {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers(),
      }),
    }
  }

  // =================================================================
  // 第 5 步：启动 UI
  // =================================================================
  try {
    // ----- 模式 A：交互终端 → TUI 全屏界面 -----
    // 就是你看到的那个带边框、有 session feed 的界面
    if (isInteractiveTerminal) {
      await runTtyApp({
        runtime,
        tools,
        model,
        messages,
        cwd,
        permissions,
      })
      return
    }

    // ----- 模式 B：非交互终端 → 简单 readline 模式 -----
    // 用于管道输入或脚本调用，没有花哨的 UI
    // 例如：echo "帮我读 README" | minicode

    // 显示启动横幅
    const mcpStatus = summarizeMcpServers(tools.getMcpServers())
    console.log(
      renderBanner(runtime, cwd, permissions.getSummary(), {
        transcriptCount: 0,
        messageCount: messages.length,
        skillCount: tools.getSkills().length,
        mcpTotalCount: mcpStatus.total,
        mcpConnectedCount: mcpStatus.connected,
        mcpConnectingCount: mcpStatus.connecting,
        mcpErrorCount: mcpStatus.error,
      }),
    )
    console.log('')

    // 创建 readline 接口，支持 tab 补全斜杠命令
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completeSlashCommand,  // 按 Tab 自动补全 /help 等
    })

    // ----- 主输入循环：逐行读取用户输入 -----
    for await (const rawInput of rl) {
      const input = rawInput.trim()
      if (!input) {
        continue  // 空行跳过
      }
      if (input === '/exit') break  // 退出

      // 处理斜杠命令（/help、/tools、/status 等）
      try {
        if (input === '/tools') {
          console.log(
            `\n${tools.list().map(tool => `${tool.name}: ${tool.description}`).join('\n')}\n`,
          )
          continue
        }

        // 尝试匹配其他内置命令
        const localCommandResult = await tryHandleLocalCommand(input, { tools })
        if (localCommandResult !== null) {
          console.log(`\n${localCommandResult}\n`)
          continue
        }

        // 未识别的斜杠命令
        if (input.startsWith('/')) {
          const matches = findMatchingSlashCommands(input)
          if (matches.length > 0) {
            console.log(`\n未识别命令。你是不是想输入：\n${matches.join('\n')}\n`)
          } else {
            console.log(`\n未识别命令。输入 /help 查看可用命令。\n`)
          }
          continue
        }
      } catch (error) {
        console.log(
          `\n${error instanceof Error ? error.message : String(error)}\n`,
        )
        continue
      }

      // ===========================================================
      // 不是斜杠命令 → 发给 AI 处理
      // ===========================================================
      // 这里就是调用 agent-loop 的地方！
      // 和你学的核心循环完全对接：
      //   1. 把用户输入追加到 messages
      //   2. 调用 runAgentTurn（核心循环）
      //   3. 拿到 AI 回复，显示给用户

      await refreshSystemPrompt()
      messages = [...messages, { role: 'user', content: input }]

      // 开始一个"权限回合"（本轮内相同操作只审批一次）
      permissions.beginTurn()
      // 同时开启一个 usage 回合，给 /cost 的 "Last turn" 视图用
      beginUsageTurn()
      try {
        // 🔄 调用核心循环！
        // AI 会在这里思考、调工具、再思考... 直到给出最终回复
        messages = await runAgentTurn({
          model,
          tools,
          messages,
          cwd,
          permissions,
        })
      } catch (error) {
        // 请求失败，把错误信息作为 assistant 消息加入历史
        const message =
          error instanceof Error ? error.message : String(error)
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: `请求失败: ${message}`,
          },
        ]
      } finally {
        permissions.endTurn()
      }

      // 找到最后一条 assistant 消息并显示给用户
      const lastAssistant = [...messages]
        .reverse()
        .find(message => message.role === 'assistant')

      if (lastAssistant?.role === 'assistant') {
        console.log(`\n${lastAssistant.content}\n`)
      }
    }

    try {
      rl.close()
    } catch {
      // Ignore double-close during EOF teardown.
    }
  } finally {
    // 程序退出前：等 MCP 加载完 + 释放工具资源
    await mcpHydration
    await tools.dispose()
  }
}

// 启动！
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
