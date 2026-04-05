# Agent Loop 边界情况深度分析

## 概览

核心循环只有 20 行，但有 4 个边界情况让代码膨胀到 300 行：

| # | 边界情况 | 问题 | 处理方式 | 代码位置 |
|---|---------|------|---------|---------|
| 1 | 空响应 | AI 什么都没说 | 自动重试 2 次 | 第 149~157 行 |
| 2 | Thinking 截断 | AI 思考到一半被切断 | 自动续请求 3 次 | 第 122~147 行 |
| 3 | Progress 标记 | AI 说"我还在做" | 不结束循环，继续 | 第 102~119 行 |
| 4 | awaitUser | 工具要等用户输入 | 暂停循环，提前返回 | 第 251~264 行 |

---

## 1. 空响应重试

### 问题
AI 偶尔返回空响应（网络抖动、模型问题等）。

### 代码流程

```typescript
// 初始化计数器
let emptyResponseRetryCount = 0

// AI 返回空
const next = await args.model.next(messages)
// next = { type: 'assistant', content: '' }

const isEmpty = isEmptyAssistantResponse(next.content)  // true

if (isEmpty && emptyResponseRetryCount < 2) {
  emptyResponseRetryCount += 1
  // 追加"请继续"消息，改变输入让 AI 重新生成
  pushContinuationPrompt('Your last response was empty...')
  continue  // 回到循环顶部重新调 model.next()
}

// 重试 2 次还是空 → 放弃，返回错误信息给用户
```

### 关键设计
**不是重新发同样的请求**，而是追加一条 user 消息。同样的输入可能产生同样的空输出，改变输入才能打破。

### 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：追加提示重试** | 改变输入打破死循环 | 多消耗 token |
| 直接重试相同请求 | 简单 | 可能反复返回空 |
| 立即报错 | 最简单 | 用户体验差 |

---

## 2. Thinking 截断恢复

### 问题
Claude 等模型有 thinking 模式。thinking 过长会被 max_tokens 截断，返回空内容。

### 代码流程

```typescript
let recoverableThinkingRetryCount = 0

const next = await args.model.next(messages)
// next = { type: 'assistant', content: '', diagnostics: { stopReason: 'max_tokens', ignoredBlockTypes: ['thinking'] } }

// 检测：内容为空 + stopReason 是截断类 + 有 thinking 块
if (isRecoverableThinkingStop({ isEmpty, stopReason, ignoredBlockTypes }) 
    && recoverableThinkingRetryCount < 3) {
  recoverableThinkingRetryCount += 1
  pushContinuationPrompt('Your response hit max_tokens during thinking...')
  continue  // 让 AI 从截断处继续
}
```

### 关键设计
和空响应**分开判断**，因为 thinking 截断一定需要续请求（不是 AI 的错），给更多重试次数（3 次 vs 2 次）。

### 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：检测 stopReason 后续请求** | 对用户透明 | 需要解析诊断信息 |
| 增大 max_tokens | 从源头解决 | 费用高 |
| 禁用 thinking | 不会截断 | 质量下降 |

---

## 3. Progress 进度标记

### 问题
AI 做复杂任务时会发中间文字"我正在分析..."，这不是最终答案，循环不能停。

### 代码流程

```typescript
const next = await args.model.next(messages)
// next = { type: 'assistant', content: '我正在分析代码...', kind: 'progress' }

if (shouldTreatAssistantAsProgress({ kind: next.kind, ... })) {
  // kind === 'progress' → return true
  
  // 记为进度消息，不是最终回复
  messages = [...messages, { role: 'assistant_progress', content: next.content }]
  pushContinuationPrompt('Continue from your progress update...')
  continue  // 循环继续，不结束
}

// 如果 kind 不是 'progress' → 当作最终回答，return 结束循环
```

### 关键设计
**默认 = 最终回答**（安全值），只有明确标了 `<progress>` 才继续。这样 AI 忘了标签也不会死循环。

### 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：默认结束，标了 progress 才继续** | 安全，不会死循环 | 依赖 AI 遵守协议 |
| 默认继续，标了 final 才结束 | 更保守 | AI 忘标 final 就永远不停 |

---

## 4. awaitUser 暂停

### 问题
ask_user 工具需要暂停循环等用户输入（比如 AI 问"你要删哪个文件？"）。

### 代码流程

```typescript
for (const call of next.calls) {
  const result = await args.tools.execute(call.toolName, call.input, ...)

  // 工具执行后，检查是否需要等用户
  if (result.awaitUser) {
    args.onAssistantMessage?.(result.output)  // 把问题显示给用户
    return messages  // 直接 return，循环结束
  }
}

// 用户回复后，外层代码会重新调用 runAgentTurn(messages)
// messages 里已包含用户的回答，AI 接着做
```

### 关键设计
不是暂停循环，而是**直接退出**。因为所有状态都在 messages 数组里，重新调用 runAgentTurn 传入 messages 就能完美恢复，不需要保存循环内部状态。

### 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：return 退出** | 简单，无状态 | 每次要重新进入函数 |
| 用 Promise 暂停循环 | 不退出函数 | 状态管理复杂 |
| 用 Generator yield | 优雅暂停 | 异步 Generator 调试难 |

---

## 总结

> **所有状态都在 messages 数组里，循环本身无状态。**
> 重试 → 追加消息；暂停 → return messages；恢复 → 重新调用传入 messages。
