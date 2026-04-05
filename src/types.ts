/**
 * ====================================================================
 * types.ts — 整个项目的类型定义
 * ====================================================================
 *
 * 这个文件定义了 Agent 系统中流转的所有数据结构。
 * 理解这些类型 = 理解整个项目的数据流。
 *
 * 数据流向：
 *   用户输入 → ChatMessage[] → ModelAdapter.next() → AgentStep
 *     → 如果是 tool_calls → 执行工具 → 结果追加到 ChatMessage[]
 *     → 如果是 assistant  → 任务完成，显示给用户
 */

// =====================================================================
// ChatMessage — 对话历史中的单条消息
// =====================================================================
//
// 整个对话以 ChatMessage[] 数组维护。
// 每一轮"思考→执行"都会往数组里追加新消息。
//
// 为什么需要 6 种角色？
//   普通聊天只需要 system/user/assistant，
//   但 Agent 还需要记录"AI 调了哪个工具"和"工具返回了什么"，
//   这样 AI 才能看到工具结果继续推理。
//
// 消息数组示例：
//   [
//     { role: 'system',              content: '你是一个编程助手...' },
//     { role: 'user',                content: '帮我读一下 README.md' },
//     { role: 'assistant_tool_call', toolName: 'read_file', input: {path:'README.md'}, ... },
//     { role: 'tool_result',         content: '# My Project\n...', ... },
//     { role: 'assistant',           content: '这个 README 的内容是...' },
//   ]
//
export type ChatMessage =
  // system: 系统提示词，告诉 AI 它是谁、能做什么
  // 通常只有一条，放在数组最前面
  | { role: 'system'; content: string }

  // user: 用户输入的自然语言消息
  | { role: 'user'; content: string }

  // assistant: AI 的最终回复文本（任务完成时）
  | { role: 'assistant'; content: string }

  // assistant_progress: AI 的中间进度消息
  // 表示"我还在做，还没完"，循环不会因此停止
  | { role: 'assistant_progress'; content: string }

  // assistant_tool_call: AI 请求调用一个工具
  // 例如：AI 决定要读取文件，就会发出这条消息
  | {
      role: 'assistant_tool_call'
      toolUseId: string    // 本次调用的唯一 ID（用于关联结果）
      toolName: string     // 工具名，如 'read_file', 'run_command'
      input: unknown       // 工具参数，如 { path: 'src/index.ts' }
    }

  // tool_result: 工具执行后的返回结果
  // 执行完工具后，把结果以这种格式追加到消息数组
  // AI 下一轮会看到这个结果，据此继续推理
  | {
      role: 'tool_result'
      toolUseId: string    // 对应哪次 tool_call 的 ID
      toolName: string     // 工具名
      content: string      // 工具输出内容（文件内容、命令输出等）
      isError: boolean     // 工具是否执行失败
    }

// =====================================================================
// ToolCall — 一次待执行的工具调用
// =====================================================================
//
// 当 AI 决定要调用工具时，ModelAdapter 会返回一个或多个 ToolCall。
// agent-loop 拿到后逐个执行，再把结果塞回消息数组。
//
export type ToolCall = {
  id: string           // 调用唯一 ID（由 LLM 生成或本地生成）
  toolName: string     // 要调用的工具名
  input: unknown       // 工具参数（JSON 对象）
}

// =====================================================================
// StepDiagnostics — 每步的诊断/调试信息
// =====================================================================
//
// 附加在 AgentStep 上的元数据，主要用于调试和错误排查。
// 不影响核心逻辑，但能帮你理解 AI 为什么做出某个决策。
//
export type StepDiagnostics = {
  stopReason?: string          // LLM 停止生成的原因：'end_turn', 'tool_use', 'max_tokens' 等
  blockTypes?: string[]        // LLM 返回的内容块类型列表：['text'], ['text', 'tool_use'] 等
  ignoredBlockTypes?: string[] // 被忽略的未知块类型（兼容性保护）
}

// =====================================================================
// AgentStep — 模型单步输出（核心类型）
// =====================================================================
//
// 这是 ModelAdapter.next() 的返回值，表示"AI 这一步想做什么"。
// 只有两种可能：
//
//   1. type: 'assistant'   → AI 直接回复了文字（可能是最终回答或进度更新）
//   2. type: 'tool_calls'  → AI 想调用工具（循环继续）
//
// agent-loop.ts 就是根据这个类型决定：继续循环还是结束。
//
export type AgentStep =
  | {
      type: 'assistant'           // AI 输出了文字
      content: string             // 文字内容
      kind?: 'final' | 'progress' // 'final'=任务完成, 'progress'=还在做, undefined=普通回复
      diagnostics?: StepDiagnostics
    }
  | {
      type: 'tool_calls'           // AI 想调用工具
      calls: ToolCall[]            // 要执行的工具列表（可以同时调多个）
      content?: string             // 工具调用同时附带的文字说明（可选）
      contentKind?: 'progress'     // 如果有文字，标记为进度更新
      diagnostics?: StepDiagnostics
    }

// =====================================================================
// ModelAdapter — 模型适配器接口（策略模式）
// =====================================================================
//
// 这是整个多模型架构的核心抽象。
//
// next() 做的事情很简单：
//   "把聊天记录交给 AI，让 AI 返回它的下一步操作"
//
//   next(messages)  →  AgentStep
//   ↑ 输入：整个聊天历史     ↑ 输出：AI 这一步想做什么
//
// 为什么叫 next？
//   因为 Agent 是一步一步执行的，每调一次 next()，AI 就往前走一步：
//
//   第 1 步: next([system, user:"读README"]) → AI 返回 tool_calls: read_file
//            ↓ 执行 read_file，把结果追加到 messages
//   第 2 步: next([system, user:"读README", tool_call, tool_result]) → AI 返回 assistant: "内容是..."
//            ↓ 拿到文字回复，循环结束
//
// 使用示例：
//
//   const step = await model.next(messages)
//
//   if (step.type === 'tool_calls') {
//     // AI 想调用工具，比如 read_file、run_command
//     // → 执行工具，把结果加入 messages，再调一次 next()
//   }
//
//   if (step.type === 'assistant') {
//     // AI 直接给出了文字回复
//     // → 显示给用户，任务完成
//   }
//
// 为什么是 interface（接口）？
//   因为不同 AI 的 API 格式不同，但对 agent-loop 来说都一样：
//
//   GeminiAdapter.next()    → 内部调 Google API，把响应翻译成 AgentStep
//   AnthropicAdapter.next() → 内部调 Claude API，把响应翻译成 AgentStep
//   OpenAIAdapter.next()    → 内部调 GPT/DeepSeek API，把响应翻译成 AgentStep
//   MockAdapter.next()      → 不调任何 API，返回假数据（测试用）
//
//   agent-loop 只管调 model.next()，不关心底层是哪个 AI。
//   这就是"策略模式"——替换策略（适配器）不需要改调用方代码。
//
export interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}
