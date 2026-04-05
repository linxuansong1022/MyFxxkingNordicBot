# MyFxxkingNordicBot 学习路线图

## 核心概念：什么是 AI Agent？

```
普通 chatbot:  用户问 → AI 答 → 结束
AI Agent:      用户问 → AI 思考 → 调工具 → 看结果 → 再思考 → 再调工具 → ... → 最终回答
```

**Agent 的本质就是一个循环**：让 AI 反复调用工具直到任务完成。你的整个项目就是在实现这个循环。

---

## 学习阶段

### 阶段 1️⃣：理解数据结构（10 分钟）

📄 **读这个文件**: `src/types.ts` — 只有 50 行

关键理解：
- `ChatMessage` — 对话中的每条消息（6 种角色）
- `ToolCall` — AI 想调用的工具（名称 + 参数）
- `AgentStep` — AI 每步的输出：要么是文字，要么是工具调用
- `ModelAdapter` — 和 LLM 通信的接口（只有一个方法 `next()`）

> 💡 这是理解一切的基础。整个项目就是在生产、消费、传递这些类型。

---

### 阶段 2️⃣：理解工具系统（20 分钟）

📄 **读这个文件**: `src/tool.ts` — 130 行

关键理解：
- `ToolDefinition` — 每个工具的定义格式（名称、描述、参数 schema、执行函数）
- `ToolRegistry` — 工具注册表（注册、查找、执行）
- 工具执行流程：`校验参数(zod) → 调用 run() → 返回 {ok, output}`

然后挑一个具体工具看看实现：
- `src/tools/read-file.ts` — 最简单的工具
- `src/tools/run-command.ts` — 稍复杂，涉及权限

> ⚠️ 工具是 AI 的"手和脚"。AI 本身只能输出文字，是工具让它能读文件、改代码、跑命令。

---

### 阶段 3️⃣：理解 LLM 通信（30 分钟）

📄 **读这个文件**: `src/gemini-adapter.ts` — 你最熟悉的

关键理解：
- 内部消息格式 `ChatMessage[]` → Gemini API 格式的转换
- 工具定义怎么告诉 LLM（`functionDeclarations`）
- LLM 返回 `functionCall` 时怎么解析成 `ToolCall`
- 重试机制（429 限流、500 服务器错误）

对比看：`src/anthropic-adapter.ts` 和 `src/openai-adapter.ts`

> 📝 三个 adapter 做的事情完全一样，只是 API 格式不同。理解一个就理解了全部。

---

### 阶段 4️⃣：理解核心循环 ⭐（30 分钟）

📄 **读这个文件**: `src/agent-loop.ts` — 277 行，**最重要的文件**

这就是 Agent 的灵魂，伪代码如下：

```typescript
while (true) {
  // 1. 把所有消息发给 LLM
  step = model.next(messages)
  
  // 2. LLM 返回纯文字？→ 任务完成，退出循环
  if (step.type === 'assistant') break
  
  // 3. LLM 返回工具调用？→ 执行工具
  for (call of step.calls) {
    result = tools.execute(call)
    messages.push(result)  // 把结果加入消息
  }
  
  // 4. 回到步骤 1，让 LLM 看到工具结果后继续思考
}
```

关键机制：
- 空响应重试（LLM 偶尔返回空）
- thinking 恢复（LLM 思考太久被截断）
- `<progress>` 标记（AI 说"我还没做完"）
- `awaitUser`（工具暂停循环等用户输入）

> 🔴 理解这个文件 = 理解所有 AI Agent 的工作原理。Claude Code、Cursor、Copilot 内部都是类似的循环。

---

### 阶段 5️⃣：理解配置和启动（15 分钟）

- `src/config.ts` — 多层配置加载，自动识别模型提供商
- `src/model-factory.ts` — 根据模型名自动选择适配器
- `src/index.ts` — 程序入口，把一切串起来

---

## 架构全景图

```
用户输入
    │
    ▼
index.ts（入口）
    ├─ config.ts     加载 settings.json
    ├─ model-factory  根据 model 名选适配器
    ├─ tool.ts       注册所有工具
    │
    ▼
agent-loop.ts（核心循环）
    │
    ├─ 1. 发消息给 LLM ──→ gemini-adapter.ts
    │                       anthropic-adapter.ts
    │                       openai-adapter.ts
    │
    ├─ 2. LLM 返回文字 ──→ 显示给用户，结束
    │
    └─ 3. LLM 返回工具调用
         │
         ├─ read-file.ts    读文件
         ├─ write-file.ts   写文件
         ├─ edit-file.ts    编辑文件
         ├─ run-command.ts  执行命令
         ├─ grep-files.ts   搜索代码
         └─ ...
         │
         └─ 把工具结果加入消息 → 回到步骤 1
```

---

## 学习方法建议

1. **边读边跑** — 在代码里加 `console.log()` 看实际运行数据
2. **跟一次完整请求** — 从你输入文字到 AI 回复，跟踪每个函数调用
3. **改一个小功能** — 比如加一个新工具，加深理解

### 推荐的第一个实验

在 `agent-loop.ts` 的循环里加一行 log，看看 AI 每一步在做什么：

```typescript
// 在循环开头加这行
console.log(`[Agent] Step ${stepCount}: type=${step.type}`, 
  step.type === 'tool_calls' ? step.calls.map(c => c.toolName) : '')
```

---

## 文件速查表

| 文件 | 行数 | 重要性 | 作用 |
|------|------|--------|------|
| `types.ts` | 50 | ⭐⭐⭐ | 所有类型定义 |
| `tool.ts` | 130 | ⭐⭐⭐ | 工具注册和执行 |
| `agent-loop.ts` | 277 | ⭐⭐⭐⭐⭐ | **核心循环** |
| `gemini-adapter.ts` | ~280 | ⭐⭐⭐⭐ | Gemini API 通信 |
| `openai-adapter.ts` | ~280 | ⭐⭐⭐ | OpenAI 兼容 API |
| `anthropic-adapter.ts` | 340 | ⭐⭐⭐ | Claude API |
| `model-factory.ts` | ~130 | ⭐⭐ | 模型自动选择 |
| `config.ts` | ~260 | ⭐⭐ | 配置加载 |
| `index.ts` | ~190 | ⭐⭐ | 程序入口 |
| `prompt.ts` | 115 | ⭐⭐ | System Prompt 构建 |
| `permissions.ts` | 501 | ⭐ | 权限管理 |
| `tty-app.ts` | 1343 | ⭐ | TUI 界面（可后期学） |
