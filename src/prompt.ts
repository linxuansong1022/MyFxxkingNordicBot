// prompt.ts
// 职责：组装发给 LLM 的 system prompt（系统提示词）
//
// 这是 LLM 每次请求都会收到的"开场白"，告诉它：
//   - 你是谁、在做什么
//   - 当前工作目录在哪
//   - 有哪些权限规则
//   - 有哪些 skill 可用
//   - 有哪些 MCP 服务器已连接
//   - 用户的全局/项目级指令（CLAUDE.md）
//   - 响应格式协议（<progress> / <final> 标记）

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { McpServerSummary } from './mcp.js'
import type { SkillSummary } from './skills.js'

// 安全读取文件：文件不存在时返回 null，不抛异常
// 用于读取 CLAUDE.md 这种"有就用、没有就跳过"的可选配置文件
async function maybeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * 构建 system prompt
 *
 * 每次用户发送消息前都会调用，确保 prompt 反映最新的：
 *   - 权限状态
 *   - skill 列表
 *   - MCP 连接情况
 *   - CLAUDE.md 内容（用户可能在会话中改了它）
 *
 * @param cwd 当前工作目录（绝对路径）
 * @param permissionSummary 权限管理器生成的状态摘要
 * @param extras 额外的上下文：skills 和 mcpServers
 * @returns 拼接好的 system prompt 字符串
 */
export async function buildSystemPrompt(
  cwd: string,
  permissionSummary: string[] = [],
  extras?: {
    skills?: SkillSummary[]
    mcpServers?: McpServerSummary[]
  },
): Promise<string> {
  // 读取两层 CLAUDE.md 配置文件（仿照 Claude Code 的做法）
  // 全局：用户的所有项目共享的指令
  // 项目：当前项目专属的指令
  const globalClaudeMd = await maybeRead(path.join(os.homedir(), '.claude', 'CLAUDE.md'))
  const projectClaudeMd = await maybeRead(path.join(cwd, 'CLAUDE.md'))

  // prompt 的各部分按数组存放，最后用空行连接
  // 这样写比一个大字符串更清晰，也方便条件添加
  const parts = [
    // 1. 身份声明：告诉 LLM 它是什么角色
    'You are MyBloodyNordicBot, a terminal coding assistant.',

    // 2. 默认行为：鼓励 LLM "动手做"而不是"光说不练"
    'Default behavior: inspect the repository, use tools, make code changes when appropriate, and explain results clearly.',
    'Prefer reading files, searching code, editing files, and running verification commands over giving purely theoretical advice.',

    // 3. 工作目录：让 LLM 知道当前在哪
    `Current cwd: ${cwd}`,

    // 4. 越界访问说明：cwd 外的路径需要审批
    'You can inspect or modify paths outside the current cwd when the user asks, but tool permissions may pause for approval first.',

    // 5. 代码改动原则：少而精
    'When making code changes, keep them minimal, practical, and working-oriented.',

    // 6. 防止"光做计划不动手"：用户明确要求做事时就直接做
    'If the user clearly asked you to build, modify, optimize, or generate something, do the work instead of stopping at a plan.',

    // 7. 提问规范：必须用 ask_user 工具，不能用纯文本提问
    // 因为纯文本提问会被当作"最终回答"，循环就结束了，用户回答后无法继续
    'If you need user clarification, call the ask_user tool with one concise question and wait for the user reply. Do not ask clarifying questions as plain assistant text.',

    // 8. 不替用户做主观决定（颜色、命名风格等）
    'Do not choose subjective preferences such as colors, visual style, copy tone, or naming unless the user explicitly told you to decide yourself.',

    // 9. 大文件读取提示：read_file 有分页机制，遇到 TRUNCATED 标记要继续读
    'When using read_file, pay attention to the header fields. If it says TRUNCATED: yes, continue reading with a larger offset before concluding that the file itself is cut off.',

    // 10. Skill 加载提示：用户提到某个 skill 名时，先 load_skill 再执行
    'If the user names a skill or clearly asks for a workflow that matches a listed skill, call load_skill before following it.',

    // 11. 响应协议：这是 agent-loop 容错机制的核心契约
    // <progress> 表示"还在做"，循环不会停
    // <final> 表示"做完了"，循环结束
    // 没有标记的纯文本默认当作"做完了"
    'Structured response protocol:',
    '- When you are still working and will continue with more tool calls, start your text with <progress>.',
    '- Only when the task is actually complete and you are ready to hand control back, start your text with <final>.',
    '- Use ask_user when clarification is required; that tool ends the turn and waits for user input.',
    '- Do not stop after a progress update. After a <progress> message, continue the task in the next step.',
    '- Plain assistant text without <progress> is treated as a completed assistant message for this turn.',
  ]

  // === 动态部分：根据当前状态追加上下文 ===

  // 权限上下文：让 LLM 知道当前有哪些预授权的目录、命令、文件
  if (permissionSummary.length > 0) {
    parts.push(`Permission context:\n${permissionSummary.join('\n')}`)
  }

  // Skill 列表：告诉 LLM 当前可用的 skill 有哪些
  // 即使没有也写"none discovered"，避免 LLM 凭空猜测
  const skills = extras?.skills ?? []
  if (skills.length > 0) {
    parts.push(
      `Available skills:\n${skills
        .map(skill => `- ${skill.name}: ${skill.description}`)
        .join('\n')}`,
    )
  } else {
    parts.push('Available skills:\n- none discovered')
  }

  // MCP 服务器列表：告诉 LLM 当前连接了哪些外部 MCP 服务器
  // 包括连接状态、工具数量、协议类型、错误信息
  const mcpServers = extras?.mcpServers ?? []
  if (mcpServers.length > 0) {
    parts.push(
      `Configured MCP servers:\n${mcpServers
        .map(server => {
          // 拼接每台服务器的状态信息：错误、协议、资源数、prompt 数
          const suffix = server.error ? ` (${server.error})` : ''
          const protocol = server.protocol ? `, protocol=${server.protocol}` : ''
          const resources =
            server.resourceCount !== undefined
              ? `, resources=${server.resourceCount}`
              : ''
          const prompts =
            server.promptCount !== undefined
              ? `, prompts=${server.promptCount}`
              : ''
          return `- ${server.name}: ${server.status}, tools=${server.toolCount}${resources}${prompts}${protocol}${suffix}`
        })
        .join('\n')}`,
    )

    // 针对已连接的 MCP 服务器，给 LLM 一些使用提示
    // 这些提示是动态生成的：只有当服务器真的有 resources 或 prompts 时才提示
    // 避免发送无用信息浪费 token
    const connectedServers = mcpServers.filter(server => server.status === 'connected')
    if (connectedServers.length > 0) {
      const hasPublishedResources = connectedServers.some(
        server => (server.resourceCount ?? 0) > 0,
      )
      const hasPublishedPrompts = connectedServers.some(
        server => (server.promptCount ?? 0) > 0,
      )

      // 基础提示：告诉 LLM MCP 工具的命名规则（mcp__server__tool）
      const capabilityHints = [
        'Connected MCP tools are already exposed in the tool list with names prefixed like mcp__server__tool. To discover callable MCP integrations, inspect the tool list or use /mcp.',
      ]

      // 如果有 MCP 服务器发布了资源，提示 LLM 可以用 list_mcp_resources / read_mcp_resource
      if (hasPublishedResources) {
        capabilityHints.push(
          'Some connected MCP servers also publish resources, so list_mcp_resources/read_mcp_resource can be useful for reading server-provided content.',
        )
      }

      // 如果有 MCP 服务器发布了 prompts，提示 LLM 可以用 list_mcp_prompts / get_mcp_prompt
      if (hasPublishedPrompts) {
        capabilityHints.push(
          'Some connected MCP servers also publish prompts, so list_mcp_prompts/get_mcp_prompt can be useful for fetching server-provided prompt templates.',
        )
      }

      parts.push(capabilityHints.join(' '))
    }
  }

  // === 用户自定义指令 ===
  // 优先级：项目级覆盖全局级（项目放在后面，LLM 通常更重视后出现的指令）

  // 全局指令：~/.claude/CLAUDE.md（用户在所有项目共用的偏好）
  if (globalClaudeMd) {
    parts.push(`Global instructions from ~/.claude/CLAUDE.md:\n${globalClaudeMd}`)
  }

  // 项目指令：当前项目根目录的 CLAUDE.md（项目专属规则）
  if (projectClaudeMd) {
    parts.push(`Project instructions from ${path.join(cwd, 'CLAUDE.md')}:\n${projectClaudeMd}`)
  }

  // 用空行连接所有部分，形成最终的 system prompt
  return parts.join('\n\n')
}
