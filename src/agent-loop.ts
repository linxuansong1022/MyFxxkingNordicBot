/**
 * ====================================================================
 * agent-loop.ts — Agent 核心循环（整个项目最重要的文件）
 * ====================================================================
 *
 * 这个文件实现了 AI Agent 的核心模式：
 *
 *   while (true) {
 *     1. 把消息历史发给 LLM
 *     2. LLM 返回文字？→ 显示给用户，结束
 *     3. LLM 返回工具调用？→ 执行工具，把结果加入消息历史
 *     4. 回到第 1 步（LLM 看到工具结果后继续思考）
 *   }
 *
 * 所有 AI Agent（Claude Code、Cursor、Copilot）的本质都是这个循环。
 * 区别只在于：工具不同、UI 不同、提示词不同。
 *
 * 一个完整的执行链：
 *
 *   用户: "帮我在 src/utils.ts 里加一个 add 函数"
 *     ↓ step 1: model.next() → AI 返回 tool_calls: read_file('src/utils.ts')
 *     ↓ step 2: 执行 read_file → 拿到文件内容 → 加入 messages
 *     ↓ step 3: model.next() → AI 返回 tool_calls: edit_file(...)
 *     ↓ step 4: 执行 edit_file → 文件已修改 → 加入 messages
 *     ↓ step 5: model.next() → AI 返回 assistant: "已添加 add 函数"
 *     ↓ 循环结束，展示回复
 */

import type { ToolRegistry } from './tool.js'
import type { ChatMessage, ModelAdapter } from './types.js'
import type { PermissionManager } from './permissions.js'

// =====================================================================
// 辅助函数
// =====================================================================

/**
 * 检查 AI 的回复是否为空。
 * LLM 偶尔会返回空响应（网络波动、模型抽风等），
 * 这时需要重试而不是直接结束。
 */
function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

/**
 * 判断 AI 的文字回复是否应该被视为"进度更新"而非"最终回答"。
 *
 * 为什么需要这个？
 *   AI 有时候会在工具调用之间发一段文字说"我正在做..."，
 *   但这不是最终答案。我们需要区分：
 *     - '我来帮你读取文件' → 进度更新，循环继续
 *     - '任务已完成，add 函数已添加' → 最终回答，循环结束
 *
 * 判断逻辑：
 *   - kind === 'progress'  → 明确标记为进度，循环继续
 *   - kind === 'final'     → 明确标记为完成，循环结束
 *   - 没有标记            → 默认当作最终回答
 */
function shouldTreatAssistantAsProgress(args: {
  kind?: 'final' | 'progress'
  content: string
  sawToolResultThisTurn: boolean
}): boolean {
  if (args.kind === 'progress') {
    return true
  }

  if (args.kind === 'final') {
    return false
  }

  if (!args.sawToolResultThisTurn) {
    return false
  }

  return false
}

/**
 * 格式化诊断信息，用于调试。
 * 当出错时，这些信息能告诉你 LLM 为什么停止了。
 */
function formatDiagnostics(args: {
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): string {
  const parts: string[] = []

  if (args.stopReason) {
    parts.push(`stop_reason=${args.stopReason}`)
  }

  if ((args.blockTypes?.length ?? 0) > 0) {
    parts.push(`blocks=${args.blockTypes!.join(',')}`)
  }

  if ((args.ignoredBlockTypes?.length ?? 0) > 0) {
    parts.push(`ignored=${args.ignoredBlockTypes!.join(',')}`)
  }

  return parts.length > 0 ? ` 诊断信息: ${parts.join('; ')}。` : ''
}

/**
 * 判断是否是"可恢复的 thinking 中断"。
 *
 * 什么意思？
 *   有些模型（如 Claude）有 thinking 模式——先在内部推理，再输出。
 *   如果 thinking 过程太长被截断了（max_tokens），
 *   返回的内容是空的，但这不是 AI 故意返回空，而是被截断了。
 *   这种情况应该自动续请求，而不是报错。
 *
 * 最多自动续 3 次，避免无限循环。
 */
function isRecoverableThinkingStop(args: {
  isEmpty: boolean
  stopReason?: string
  ignoredBlockTypes?: string[]
}): boolean {
  if (!args.isEmpty) {
    return false
  }

  if (args.stopReason !== 'pause_turn' && args.stopReason !== 'max_tokens') {
    return false
  }

  return (args.ignoredBlockTypes ?? []).includes('thinking')
}

// =====================================================================
// runAgentTurn — 核心循环入口
// =====================================================================
//
// 这个函数执行一个完整的"Agent 回合"：
//   1. 用户发送一条消息
//   2. AI 可能调用 0~N 个工具
//   3. AI 给出最终回复
//   4. 返回更新后的完整消息数组
//
// 参数说明：
//   model       — 模型适配器（Gemini/Claude/GPT 等）
//   tools       — 工具注册表（可执行的工具列表）
//   messages    — 当前的消息历史
//   cwd         — 当前工作目录
//   permissions — 权限管理器（危险操作需要用户审批）
//   maxSteps    — 最大工具调用步数（防止 AI 死循环调工具）
//   on*         — 回调函数，用于 UI 实时显示进度
//
// 返回值：
//   更新后的 ChatMessage[]，包含了所有新增的工具调用和 AI 回复
//
export async function runAgentTurn(args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?: number
  onToolStart?: (toolName: string, input: unknown) => void       // 工具开始执行时回调
  onToolResult?: (toolName: string, output: string, isError: boolean) => void  // 工具执行完毕时回调
  onAssistantMessage?: (content: string) => void                 // AI 给出最终回复时回调
  onProgressMessage?: (content: string) => void                  // AI 给出进度更新时回调
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps
  let messages = args.messages

  // --- 各种计数器，用于容错和诊断 ---
  let emptyResponseRetryCount = 0         // 空响应重试次数（最多 2 次）
  let recoverableThinkingRetryCount = 0   // thinking 中断恢复次数（最多 3 次）
  let toolErrorCount = 0                  // 工具报错计数
  let sawToolResultThisTurn = false       // 本轮是否已经有工具执行过

  /**
   * 追加一条"续写提示"消息。
   * 当 AI 返回空响应或进度更新时，我们用这个方法
   * 告诉 AI "请继续"，引导它走下一步。
   */
  const pushContinuationPrompt = (content: string) => {
    messages = [
      ...messages,
      {
        role: 'user',
        content,
      },
    ]
  }

  // =================================================================
  // 🔄 核心循环开始
  // =================================================================
  // for 循环控制最大步数。每次迭代 = AI 思考一次 + 可能执行工具。
  // 如果没有设 maxSteps，就无限循环直到 AI 给出最终回答。
  //
  for (let step = 0; maxSteps == null || step < maxSteps; step++) {

    // -----------------------------------------------------------------
    // 第 1 步：把所有消息发给 LLM，拿到它的下一步操作
    // -----------------------------------------------------------------
    const next = await args.model.next(messages)

    // =================================================================
    // 情况 A：AI 返回了文字（type === 'assistant'）
    // =================================================================
    // AI 没有要调用工具，而是直接给出了文字回复。
    // 但文字回复有好几种情况需要处理...
    //
    if (next.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(next.content)

      // ----- 情况 A1：进度更新 -----
      // AI 发了一段 <progress> 标记的文字，表示"我还在做，还没完成"。
      // 处理方式：记录下来，发一条"请继续"的提示，循环继续。
      if (
        !isEmpty &&
        shouldTreatAssistantAsProgress({
          kind: next.kind,
          content: next.content,
          sawToolResultThisTurn,
        })
      ) {
        args.onProgressMessage?.(next.content)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: next.content },
        ]
        pushContinuationPrompt(
          sawToolResultThisTurn && next.kind !== 'progress'
            ? 'Continue from your progress update. You have already used tools in this turn, so treat plain status text as progress, not a final answer. Respond with the next concrete tool call, code change, or an explicit <final> answer only if the task is truly complete.'
            : 'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue  // ← 继续循环，让 AI 接着做
      }

      // ----- 情况 A2：thinking 被截断 -----
      // 模型在内部 thinking 时被 max_tokens 截断了，
      // 返回的内容是空的。这不是 AI 故意的，需要自动续请求。
      // 最多续 3 次。
      if (
        isRecoverableThinkingStop({
          isEmpty,
          stopReason: next.diagnostics?.stopReason,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        }) &&
        recoverableThinkingRetryCount < 3
      ) {
        recoverableThinkingRetryCount += 1
        const stopReason = next.diagnostics?.stopReason
        const progressContent =
          stopReason === 'max_tokens'
            ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
            : '模型返回 pause_turn，正在继续请求后续步骤...'
        args.onProgressMessage?.(progressContent)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: progressContent },
        ]
        pushContinuationPrompt(
          stopReason === 'max_tokens'
            ? 'Your previous response hit max_tokens during thinking before producing the next actionable step. Resume immediately and continue with the next concrete tool call, code change, or an explicit <final> answer only if the task is complete. Do not repeat the earlier plan.'
            : 'Resume from the previous pause_turn and continue the task immediately. Produce the next concrete tool call, code change, or an explicit <final> answer only if the task is complete.',
        )
        continue  // ← 继续循环
      }

      // ----- 情况 A3：空响应，但还有重试机会 -----
      // LLM 偶尔会返回空消息（网络抖动、模型问题等）。
      // 最多自动重试 2 次。
      if (isEmpty && emptyResponseRetryCount < 2) {
        emptyResponseRetryCount += 1
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? 'Your last response was empty after recent tool results. Continue immediately by trying the next concrete step, adapting to any tool errors, or giving an explicit <final> answer only if the task is complete.'
            : 'Your last response was empty. Continue immediately with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue  // ← 重试
      }

      // ----- 情况 A4：空响应，重试次数用完了 -----
      // 已经重试了 2 次还是空的，放弃，告诉用户。
      if (isEmpty) {
        const diagnosticsSuffix = formatDiagnostics({
          stopReason: next.diagnostics?.stopReason,
          blockTypes: next.diagnostics?.blockTypes,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        })
        const fallbackContent =
          sawToolResultThisTurn
            ? toolErrorCount > 0
              ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${toolErrorCount} 个工具报错；请重试、调整命令，或让模型改用其他方案。${diagnosticsSuffix}`
              : `工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。${diagnosticsSuffix}`
            : `模型返回空响应，已停止当前回合。请重试，或要求模型继续。${diagnosticsSuffix}`

        args.onAssistantMessage?.(fallbackContent)
        return [
          ...messages,
          {
            role: 'assistant',
            content: fallbackContent,
          },
        ]
      }

      // ----- 情况 A5：正常的最终回复 ✅ -----
      // AI 给出了有内容的文字回复，且不是进度更新。
      // 这就是最终答案！把它加入消息历史，循环结束。
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: next.content,
      }
      const withAssistant: ChatMessage[] = [
        ...messages,
        assistantMessage,
      ]

      if (!isEmpty) {
        args.onAssistantMessage?.(next.content)
      }

      return withAssistant  // ← 🎉 循环结束，返回完整消息历史
    }

    // =================================================================
    // 情况 B：AI 返回了工具调用（type === 'tool_calls'）
    // =================================================================
    // AI 不想直接回答，而是要调用工具（读文件、执行命令等）。
    // 需要：1. 处理附带的文字  2. 逐个执行工具  3. 继续循环

    // ----- 处理工具调用附带的文字内容 -----
    // AI 有时会在调工具的同时说一些话，比如"让我先读一下这个文件..."
    if (next.content) {
      if (next.contentKind === 'progress') {
        // 进度更新：记录但不结束循环
        args.onProgressMessage?.(next.content)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: next.content },
        ]
        pushContinuationPrompt(
          'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
      } else {
        // 普通文字：存入消息历史
        args.onAssistantMessage?.(next.content)
        messages = [
          ...messages,
          { role: 'assistant', content: next.content },
        ]
      }
    }

    // 边界情况：AI 返回了文字但没有工具调用，且不是进度更新
    // → 当作最终回复处理
    if ((next.calls?.length ?? 0) === 0 && next.content && next.contentKind !== 'progress') {
      return messages
    }

    // -----------------------------------------------------------------
    // 第 2 步：逐个执行工具 🔧
    // -----------------------------------------------------------------
    // 遍历 AI 请求的每个工具调用，执行它们，
    // 并把 tool_call + tool_result 一对一对地追加到消息历史。
    //
    for (const call of next.calls) {
      // 通知 UI：工具开始执行
      args.onToolStart?.(call.toolName, call.input)

      // 执行工具（可能会触发权限审批弹窗）
      const result = await args.tools.execute(
        call.toolName,
        call.input,
        { cwd: args.cwd, permissions: args.permissions },
      )

      // 记录状态
      sawToolResultThisTurn = true
      if (!result.ok) {
        toolErrorCount += 1
      }

      // 通知 UI：工具执行完毕
      args.onToolResult?.(call.toolName, result.output, !result.ok)

      // 把工具调用和结果追加到消息历史
      // 这样下一次 model.next() 时，AI 就能看到工具的输出
      messages = [
        ...messages,
        // 记录 AI 调用了什么工具、传了什么参数
        {
          role: 'assistant_tool_call',
          toolUseId: call.id,
          toolName: call.toolName,
          input: call.input,
        },
        // 记录工具返回了什么结果
        {
          role: 'tool_result',
          toolUseId: call.id,
          toolName: call.toolName,
          content: result.output,
          isError: !result.ok,
        },
      ]

      // ----- 特殊情况：awaitUser（等待用户输入） -----
      // 某些工具（如 ask_user）需要暂停循环等用户回复。
      // result.awaitUser 为 true 时，把问题显示给用户，
      // 然后提前返回，等用户回复后再开始新的 runAgentTurn。
      if (result.awaitUser) {
        const question = result.output.trim()
        if (question.length > 0) {
          args.onAssistantMessage?.(question)
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: question,
            },
          ]
        }
        return messages  // ← 暂停循环，等用户输入
      }
    }

    // 所有工具执行完毕，回到循环顶部。
    // 下一次 model.next() 会看到所有工具的执行结果，
    // AI 据此决定：是继续调工具，还是给出最终回答。
  }

  // =================================================================
  // 循环正常退出：达到 maxSteps 上限
  // =================================================================
  // 防止 AI 无限循环调工具（比如 AI 一直在改文件但永远不满意）。
  // 强制停止，告诉用户已达到步数限制。
  //
  const maxStepContent = `达到最大工具步数限制，已停止当前回合。`
  args.onAssistantMessage?.(maxStepContent)
  return [
    ...messages,
    {
      role: 'assistant',
      content: maxStepContent,
    },
  ]
}
