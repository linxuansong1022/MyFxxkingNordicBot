## 4. 各模块详解

### 4.0 程序入口（index.ts — 290 行）

#### 一句话定位

> **`index.ts` = 装配工**。它不发明任何新东西，只是按顺序把 config / tool / permissions / model / prompt 这几个模块的入口函数串起来，最后进入 "等输入 → 刷新 prompt → 调 agent-loop → 显示输出" 的无限循环。

整个项目最聪明的地方在于：用最朴素的方式组装，没有依赖注入框架、没有复杂的 IoC 容器。`index.ts` 200 行就把所有东西串起来了。

#### 5 步装配

```
程序启动
   ↓
① 加载 config        ← config.ts (loadRuntimeConfig)
   ↓
② 注册工具          ← tool.ts + tools/*.ts (createDefaultToolRegistry)
   ↓ (异步加载 MCP 工具，不阻塞)
③ 创建权限管理器    ← permissions.ts (new PermissionManager)
   ↓
④ 创建模型适配器    ← model-factory.ts → gemini-adapter.ts 等
   ↓
⑤ 构建初始 messages ← prompt.ts (buildSystemPrompt → messages[0])
   ↓
启动 UI
   ├─ 交互终端 → tty-app.ts (TUI 全屏)
   └─ 管道输入 → readline 简单循环
```

**关键设计：MCP 异步加载**。因为 MCP 服务器连接慢，如果等它连完才启动 TUI，用户要等很久。所以让它在后台加载（`hydrateMcpTools(...).catch(...)` 没有 await），TUI 先启动起来，连上后通过 `refreshSystemPrompt()` 自动告诉 AI 有新工具。

#### 主循环（整个项目的"心跳"）

```ts
for await (const rawInput of rl) {
  // 1. 处理 slash 命令
  if (input.startsWith('/')) { ... continue }

  // 2. 普通对话：刷新 prompt + 追加用户输入
  await refreshSystemPrompt()
  messages = [...messages, { role: 'user', content: input }]

  // 3. 开始权限回合（清空 turn 缓存）
  permissions.beginTurn()
  try {
    // 4. 调用 agent-loop（核心循环！）
    messages = await runAgentTurn({ model, tools, messages, cwd, permissions })
  } finally {
    permissions.endTurn()
  }

  // 5. 显示 AI 回复
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  console.log(lastAssistant.content)
}
```

这 20 行就是整个 mini-code 的核心交互逻辑。TUI 模式（`tty-app.ts`）里也是同样的循环，只是包了一层界面渲染。

#### 两种 UI 模式

```ts
const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
```

| 模式 | 触发条件 | 实现 |
|------|---------|------|
| TUI | 真终端 | `runTtyApp()` 全屏接管，带边框、状态栏、session feed |
| readline | 管道/重定向 | 简单 readline 循环 + 纯文本输出 |

**为什么要两种**：TUI 需要"全屏接管终端"，但 `echo "xxx" \| minicode` 这种管道输入没有真终端，TUI 渲染会乱。readline 模式简单粗暴，适合脚本调用。

#### 一张依赖关系图

```
┌─────────────────────────────────────────────────────────┐
│                       index.ts                          │
│                   （装配 + 启动）                       │
└─────────────────────────────────────────────────────────┘
         │
         ├──→ config.ts          → RuntimeConfig
         ├──→ tool.ts            → ToolRegistry
         │     └─ tools/*.ts     → 12 个内置工具
         │     └─ mcp.ts         → MCP 工具（异步）
         ├──→ permissions.ts     → PermissionManager
         ├──→ model-factory.ts   → ModelAdapter
         ├──→ prompt.ts          → messages[0] (system)
         │
         └──→ 主循环
                ↓
              用户输入
                ↓
              refreshSystemPrompt()  ← prompt.ts (再次调)
                ↓
              messages.push(user)
                ↓
              runAgentTurn(...)    ← agent-loop.ts
                                       ↓
                                  model.next()  ← adapter
                                       ↓
                                  tools.execute()  ← tool.ts
                                       ↓
                                  permissions.ensure()  ← permissions.ts
```

**这一张图就是整个项目所有模块的关系**。学完所有"零件"之后看 `index.ts`，会有"原来如此"的豁然开朗感。

#### Trade-off

**Trade-off 1 — TTY 检测自动切换 vs 强制单一模式**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：自动检测 isTTY 切换** | 同一个二进制既能当交互工具也能管道用 | 实现要写两套 UI |
| 只支持 TUI 模式 | 实现简单 | 无法在 CI / 脚本中使用 |
| 只支持 readline 模式 | 实现简单 | 体验差，没有现代 TUI |

选当前方案的原因：mini-code 既是开发工具又要能脚本化调用，两种场景都得支持。

**Trade-off 2 — MCP 异步加载 vs 启动时等连接**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：异步加载，不阻塞启动** | TUI 立刻可用，体验好 | 用户可能在 MCP 连上前发消息（但下一轮 refresh 会同步） |
| 启动时 await 所有 MCP | 第一条消息就有完整工具列表 | 启动慢，可能要等几秒 |

选当前方案的原因：用户对"启动慢"特别敏感，宁可第一条消息少几个工具，也要让 TUI 秒开。

#### 你需要记住的就 2 件事

1. **5 步装配**：config → tools → permissions → adapter → messages
2. **2 种 UI 模式**：interactive (TUI) vs 非 interactive (readline)

其他细节（slash 命令处理、错误恢复、MCP 异步加载）都是辅助实现。

---

### 4.1 类型系统（types.ts — 49 行）

这是理解整个项目的起点。定义了三个核心概念：

**ChatMessage** — 对话中每条消息的类型：
```
system         → system prompt（告诉 LLM 它是谁）
user           → 用户说的话
assistant      → LLM 的最终回复
assistant_progress → LLM 的中间进度（"还在做"）
assistant_tool_call → LLM 请求调用某个工具
tool_result    → 工具执行后的结果
```

整个对话就是一个 `ChatMessage[]` 数组，每一轮循环往里追加新消息。

**AgentStep** — LLM 每次返回的内容，只有两种可能：
- `type: 'assistant'` → 纯文本回复
- `type: 'tool_calls'` → 请求调用一个或多个工具

**ModelAdapter** — 模型接口，只有一个方法：
```typescript
interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}
```

**为什么这么设计：** 把"模型返回什么"抽象成一个接口，就可以轻松换模型。目前有两个实现：`AnthropicModelAdapter`（真实 API）和 `MockModelAdapter`（离线测试）。如果你想接 Gemini，只需要再写一个 adapter。

**Trade-off — 模型适配器：工厂+策略模式 vs 统一 SDK vs 硬编码**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：工厂 + 策略模式** | 加新模型只需加一个文件，不改主逻辑 | 前缀匹配不够精确 |
| 统一 SDK（如 LiteLLM） | 一行代码支持所有模型 | 供应链风险、额外依赖、调试困难 |
| 硬编码 if-else | 最直接 | 每加一个模型要改核心代码 |

---

### 4.2 工具系统（tool.ts — 130 行）

**ToolRegistry** 是工具的管理中心。

每个工具是一个对象，有四个部分：
```
name         → 工具名，LLM 用这个名字来调用
description  → 告诉 LLM 这个工具做什么（LLM 根据这个描述决定要不要用）
inputSchema  → JSON Schema 格式的参数说明（发给 LLM 看的）
schema       → Zod 校验器（运行时检查参数是否合法）
run()        → 实际执行函数，返回 { ok: boolean, output: string }
```

**ToolRegistry 的职责：**
- `list()` → 列出所有工具（发给 LLM 让它知道有哪些工具可用）
- `find(name)` → 按名字找工具
- `execute(name, input, context)` → 找工具 → zod 校验 → 执行 → 捕获异常
- `addTools()` → 动态添加工具（MCP 工具在启动后异步注入）
- `dispose()` → 清理资源（关闭 MCP 子进程等）

**为什么要用 zod 做双重校验：** LLM 生成的参数可能不合法（比如缺必填字段、类型错误）。JSON Schema 是给 LLM 看的说明书，zod 是运行时的安全门。两层防护。

---

#### 实战：如何加一个新工具（以 `count_lines` 为例）

加新工具是 mini-code 最常见的扩展操作。它**没有任何魔法**——就是写一个对象 + 在数组里加一项。

**两步走：**

**Step 1：在 `src/tools/` 下新建一个文件**（如 `count-lines.ts`），导出一个 `ToolDefinition` 对象。模板如下：

```ts
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path: string }

export const countLinesTool: ToolDefinition<Input> = {
  name: 'count_lines',
  description:
    'Count the number of lines in a UTF-8 text file relative to the workspace root. Prefer this over read_file when you only need a line count — it does not load file content into context.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  schema: z.object({ path: z.string() }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'read')
    const content = await readFile(target, 'utf8')
    const lineCount =
      content.length === 0
        ? 0
        : content.endsWith('\n')
          ? content.split('\n').length - 1
          : content.split('\n').length
    return { ok: true, output: `FILE: ${input.path}\nLINES: ${lineCount}` }
  },
}
```

**Step 2：在 `src/tools/index.ts` 注册它**——加一行 import，加一项到 `createDefaultToolRegistry` 的数组里。完事。

#### 写工具的 7 条铁律

1. **设计前先想 token 成本**：能在本地廉价计算的就抽成工具，把 O(文件大小) 的 token 开销压成 O(1)。"为什么不让 LLM 自己读文件数行"——因为 LLM 数 5 万行要塞 50 万 token 进上下文，本地 `split('\n')` 是纳秒级零成本
2. **`description` 是产品文案**：写"prefer X over Y when ..."直接帮 LLM 做决策。LLM 看不到你的代码，只看 description 决定调不调
3. **两份 schema 都要写**：`inputSchema` (JSON Schema) 跨网络传给 LLM，`schema` (zod) 本地校验。两个世界的合同，必须各写一份
4. **路径必须过 `resolveToolPath`**：绝不自己 `path.resolve` / `path.join`。安全检查统一收口到一个守门员函数
5. **永远用异步 IO**：`readFile` (promises) 而不是 `readFileSync`。Node 单线程，同步 IO 会卡死 UI、阻塞其他工具
6. **不要写 try/catch**：`ToolRegistry.execute()` 已经包了一层（tool.ts 第 139-146 行）。工具内部 throw 即可，会被自动转成 `{ ok: false, output: 错误消息 }` 返回给 LLM
7. **tool result 必须自包含**：返回 `FILE: xxx\nLINES: 42` 而不是只返回 `42`。LLM 可能并行调多个工具，结果脱离 input 也要能读懂

#### 工具调用的完整链路（请记住这张图）

```
启动阶段（一次性）
  ① 你写 ToolDefinition 对象
  ② tools/index.ts 把它放进数组
  ③ createDefaultToolRegistry() 创建 ToolRegistry 实例
  ④ agent-loop 拿到 registry，握在手里

每轮对话（循环）
  ⑤ 用户输入
  ⑥ adapter 把所有工具的 name+description+inputSchema 塞进 HTTP 请求
  ⑦ LLM 收到请求，决定 → 输出 functionCall
  ⑧ adapter 解析成 AgentStep
  ⑨ agent-loop 调 ToolRegistry.execute()
  ⑩ ToolRegistry: find → zod 校验 → 调 run() → try/catch
  ⑪ run() 真的干活（读文件、调 API、跑命令）
  ⑫ 返回 ToolResult，塞回 messages
  ⑬ 回到 ⑥，再发一轮请求，LLM 看到结果生成最终回答
```

**核心认知**：LLM 不直接执行任何东西。它只输出"我想调 X 工具，参数是 Y"这样的意图文本，所有真正的执行都是 agent 干的。所有"自主行动"都是程序员预先摆好的多米诺骨牌，LLM 只是推倒第一块。

#### 工具系统的"餐厅模型"

| 角色 | 类比 |
|---|---|
| LLM | 顾客（看菜单点菜，不进厨房） |
| `ToolDefinition` | 菜单上的一道菜 |
| `ToolRegistry` | 菜单本身 |
| `inputSchema` | 菜单上的"忌口选项"（顾客填表用） |
| `schema` (zod) | 厨房的安检员（防顾客乱填） |
| `run()` | 厨师真的炒菜 |
| `ToolResult` | 端上桌的成品 |
| agent-loop | 服务员（来回跑腿） |

加一个工具 = 在菜单上加一道菜。系统的扩展性来自这个最朴素的设计：**没有插件机制，没有自动发现，所有能力都在 `tools/index.ts` 一目了然**。

---

### 4.3 Agent Loop（agent-loop.ts — 277 行）

**整个项目最核心的文件。**

`runAgentTurn()` 函数做一件事：接收用户输入后，驱动 LLM 完成一整轮工作。

**主循环逻辑：**
```
for 每一步:
  1. 调用 model.next(messages) 获取 LLM 响应
  2. 如果是纯文本 → 显示给用户，return
  3. 如果是工具调用 → 执行每个工具，把结果追加到 messages
  4. 继续下一步（回到 1）
```

**容错机制（这些是生产环境必须的）：**

| 问题 | 处理方式 | 重试上限 |
|------|---------|---------|
| LLM 返回空响应 | 自动追加提示让 LLM 继续 | 2 次 |
| LLM 在 thinking 阶段被截断 | 自动追加续写提示 | 3 次 |
| LLM 发 `<progress>` 标记 | 当作"还在做"，循环继续 | 无限制 |
| 工具返回 `awaitUser: true` | 暂停循环，等用户输入 | - |
| 达到 maxSteps | 停止循环，告知用户 | - |

**为什么 progress 机制很重要：** LLM 有时做复杂任务需要多步思考。如果没有 progress，LLM 说了一句中间状态的话就会被当作最终答案，循环就结束了。`<progress>` 标记让 LLM 告诉系统"我还没做完，别停"。

**Trade-off — 状态管理：messages 即状态 vs 循环内保持状态**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：所有状态存在 messages 数组里** | 简单、可序列化、暂停/恢复只需 return | messages 数组不断增长 |
| 循环内维护独立状态对象 | 内存可控 | 暂停/恢复时状态难同步 |

**Trade-off — 空响应重试：追加提示 vs 简单重试**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：追加 user 消息再重试** | 改变输入，打破死循环 | 多消耗 token |
| 直接重试相同请求 | 简单 | 同样输入可能产生同样空输出 |
| 立即报错给用户 | 最简单 | 用户体验差 |

**Trade-off — Progress 默认行为：默认结束 vs 默认继续**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：没标 `<progress>` = 最终回答** | 安全，AI 忘标标签也不会死循环 | 极少数情况 AI 过早结束 |
| 默认继续（只有 `<final>` 才结束） | 更保守 | AI 忘标 final 就永远不停 |

---

### 4.4 模型适配器（anthropic-adapter.ts / gemini-adapter.ts / openai-adapter.ts）

#### 一句话定位

**Adapter = 翻译官 + 通信员**：把项目内部的统一消息格式（`ChatMessage[]`）翻译成某家 LLM API 要的格式，发 HTTP 请求，再把响应翻译回统一的 `AgentStep`。

**它不思考、不决策、不记忆**——所有"该不该继续循环、该不该执行工具"的判断都在 agent-loop 里做，adapter 只负责"格式转换 + 网络通信"。

#### 接口（你只需要记这一个）

```ts
interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}
```

- **进去**：完整的对话历史
- **出来**：模型的下一步决定（说话 or 调工具）

整个 agent-loop 就靠这个方法跟模型对话，**完全不知道**底下用的是哪家 API。

#### 整体流程（4 步，每个 adapter 都一样）

```
agent-loop 调 adapter.next(messages)
              ↓
    ┌──────────────┐
    │   1. 翻译    │  ChatMessage[] → 这家 API 要的格式
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │  2. 发请求   │  HTTP POST 到 API 端点
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │  3. 等响应   │  失败就重试（429/5xx，指数退避）
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │  4. 翻译回来 │  API 响应 → AgentStep
    └──────┬───────┘
           ↓
    返回给 agent-loop
```

#### 关键判断（决定 agent loop 走向）

第 4 步翻译响应时做一个二元分类：

```ts
if (toolCalls.length > 0) {
  return { type: 'tool_calls', calls: ... }   // → agent-loop 会执行工具
} else {
  return { type: 'assistant', content: ... }  // → agent-loop 会检查是否结束
}
```

**有工具调用 → `tool_calls` 类型 → 循环继续**
**没工具调用 → `assistant` 类型 → 看 `<final>` 标记决定结束**

这是 adapter 唯一做的"分类"工作。

#### 各家 API 的差异（不需要记，只需要知道存在）

| 维度 | Anthropic | Gemini | OpenAI |
|------|-----------|--------|--------|
| 端点 | `/v1/messages` | `/v1beta/models/xxx:generateContent` | `/v1/chat/completions` |
| 认证 | `x-api-key` header | URL `?key=xxx` 参数 | `Authorization: Bearer` header |
| 消息字段 | `messages[]` | `contents[]` | `messages[]` |
| system 放哪 | 顶层 `system` 字段 | 顶层 `systemInstruction` 字段 | 混在 messages 里（system role） |
| 工具调用块 | `tool_use` block | `functionCall` part | `tool_calls` 数组 |
| 工具结果块 | `tool_result` block | `functionResponse` part | `tool` role 消息 |

**共同特点：** Anthropic/Gemini 都把 system prompt 单独抽出来，不混进消息数组。

#### 重试策略

| Adapter | 触发条件 | 等多久 |
|---------|---------|-------|
| Anthropic | 429 / 5xx | 优先用响应头 `Retry-After`，没有则指数退避 |
| Gemini | 429 / 5xx | 指数退避 + 随机抖动 |

为什么不重试 4xx：客户端错误（参数错、认证错）重试也是错，浪费时间。

#### 两个 adapter 的差异（如果你打开两个文件对比）

```
gemini-adapter           anthropic-adapter
────────────────         ────────────────
toGeminiContents()       toAnthropicMessages()
contents[]               messages[]
systemInstruction        system (顶层)
functionCall part        tool_use block
functionResponse part    tool_result block
?key=xxx                 x-api-key header
```

**两边输入和输出完全一样，只是中间翻译的目标格式不同。** 看懂一个就等于看懂另一个的 80%。

#### 一个真实例子串起来

用户问："帮我读一下 prompt.ts"：

```
agent-loop                        adapter
────────────────────────────────────────────
"帮我读 prompt.ts" + 历史 ──→
                                  1. 翻译成 Gemini 格式
                                  2. POST 到 generativelanguage.googleapis.com
                                  3. 等响应
                                  4. 解析：text + functionCall(read_file)
                                  5. 因为有 functionCall:
                                     return { type: 'tool_calls', calls: [...] }
                            ←──
看到 tool_calls
→ 执行 read_file
→ 结果追加到 messages
→ 再调一次 adapter.next()    ──→
                                  重复 1-4 步
                                  这次解析完没有 functionCall:
                                  return { type: 'assistant',
                                           content: '<final> 这个文件...',
                                           kind: 'final' }
                            ←──
看到 assistant + kind=final
→ 结束循环
→ 显示给用户
```

**你看到的"AI 给你的回答"，本质上就是 AgentStep 在 agent-loop 里走了几个回合的最终结果。**

#### 真实 HTTP 请求长什么样（debug 验证）

用户发"hi"时，实际发给 Gemini 的 JSON 长这样（精简版）：

```json
{
  "systemInstruction": {
    "parts": [{ "text": "You are MyBloodyNordicBot... cwd: /xxx ... <progress>/<final> 协议..." }]
  },
  "contents": [
    { "role": "user", "parts": [{ "text": "hi" }] }
  ],
  "tools": [{
    "functionDeclarations": [
      { "name": "read_file", "parameters": { "type": "OBJECT", ... } },
      { "name": "run_command", ... },
      ...共 12 个工具
    ]
  }]
}
```

**每次发消息，这 3 样东西都打包在一个 HTTP POST 里：**

| 字段 | 内容 | 来源 |
|------|------|------|
| `systemInstruction` | 身份、cwd、规则、skills、`<progress>`/`<final>` 协议 | `buildSystemPrompt()` |
| `contents` | 你说的话 + 完整历史对话 | `messages[]` 数组累积 |
| `tools` | 所有可用工具的声明 | `ToolRegistry.list()` |

**Gemini 没有任何记忆**——它每次从零开始看这 3 样东西，然后决定回话还是调工具。所谓"对话上下文"，是客户端每次把完整历史重新发一遍造成的效果。

#### POST 之后发生了什么（完整通信过程）

```
你的电脑                          Google 服务器
────────                          ──────────────
fetch(url, { POST, body })  ──→   收到请求
                                  Gemini 模型处理（几秒）
                            ←──   返回 HTTP 响应 JSON
解析 candidates[0].content.parts
翻译成 AgentStep
还给 agent-loop
```

**Gemini 响应的 JSON 结构：**

```json
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [
        { "text": "我先读一下文件" },
        { "functionCall": { "name": "read_file", "args": { "path": "prompt.ts" } } }
      ]
    },
    "finishReason": "STOP"
  }]
}
```

adapter 遍历 `parts`，分类收集：
- `text` → 收进 `textParts`
- `functionCall` → 收进 `toolCalls`

**3 种可能结果：**

| Gemini 返回什么 | adapter 返回什么 | agent-loop 做什么 |
|---------------|----------------|-----------------|
| 只有 text | `{ type: 'assistant' }` | 看 `<final>` 决定是否结束 |
| 只有 functionCall | `{ type: 'tool_calls' }` | 执行工具，继续循环 |
| text + functionCall | `{ type: 'tool_calls', content: text }` | 执行工具，继续循环 |
| 空响应（被安全过滤） | `{ type: 'assistant', content: '' }` | 当作结束处理 |

**一句话总结通信全过程：**
POST 发出去 → 等 Gemini 处理 → 收回 JSON → 遍历 `parts` → 有 `functionCall` 返回 `tool_calls`，没有返回 `assistant` → 还给 agent-loop 决策。

#### Trade-off

**Trade-off 1 — 每家写一个 adapter vs 用统一 SDK（如 LangChain）**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：手写 adapter** | 零依赖；完全控制；翻译规则透明 | 加新模型要写一个新 adapter（~300 行） |
| 用 LangChain 等抽象 | 加新模型只改一行配置 | 抽象漏洞多；版本依赖重；调试困难 |

选当前方案的原因：项目目标是"可读的最小实现"，宁可写 300 行透明代码也不引入一个 megabyte 级的依赖。

**Trade-off 2 — adapter 不做任何业务判断**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：adapter 只翻译，不判断** | 职责单一；agent-loop 行为统一不依赖 adapter | adapter 之间有重复（progress 标记解析等） |
| 让 adapter 决定循环是否结束 | 减少代码重复 | 不同 adapter 行为不一致；agent-loop 失去控制权 |

选当前方案的原因：**所有业务逻辑应该在一个地方**（agent-loop），adapter 只是 IO 层。这样换 adapter 不会改变 agent 行为。

**Trade-off 3 — 重试限制为 4 次 + 指数退避 vs 无限重试**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：最多 4 次** | 避免无限等待；用户体验可控 | 服务长时间挂掉时会失败 |
| 无限重试 | 服务恢复后自动成功 | 卡死整个 agent；用户不知道发生了什么 |

选当前方案的原因：fail-fast 原则——宁可失败让用户重试，也不要静默卡住。

#### 你需要记住的就 3 件事

1. **接口**：`next(messages) → AgentStep`
2. **职责**：翻译 + 发请求 + 翻译回来
3. **不做**：不做任何业务决策（这是 agent-loop 的事）

其他细节（重试算法、字段映射、schema 转换）都是实现细节，**忘了就忘了**，要用时回来翻代码就行。

---

### 4.5 权限系统（permissions.ts — 501 行）

控制 LLM 对文件系统和命令的访问权限。**这是安全的核心。**

**三类权限检查：**

| 类型 | 触发条件 | 检查逻辑 |
|------|---------|---------|
| 路径权限 | 访问 cwd 以外的路径 | `ensurePathAccess()` |
| 命令权限 | 执行危险命令 | `ensureCommand()` |
| 编辑权限 | 写入/修改文件 | `ensureEdit()` |

**危险命令检测（硬编码的规则）：**
- `git reset --hard` → 会丢失本地修改
- `git clean` → 会删未跟踪文件
- `git push --force` → 会改写远端历史
- `npm publish` → 会发布到公共仓库
- `node / python3 / bash` → 可执行任意代码

**权限决策的粒度：**
```
allow_once     → 只允许这一次
allow_always   → 永久允许（写入 ~/.mini-code/permissions.json）
allow_turn     → 本轮对话内允许这个文件
allow_all_turn → 本轮对话内允许所有编辑
deny_once      → 只拒绝这一次
deny_always    → 永久拒绝
deny_with_feedback → 拒绝，并把原因反馈给 LLM
```

**为什么有 `deny_with_feedback`：** 用户可以告诉 LLM "不要这样改，应该那样改"，LLM 会收到这个反馈并调整方案。这比简单的"拒绝"更有用。

#### 一句话定位

> **权限系统 = 工具执行前的"门卫"**。AI 每次要读文件、写文件、执行命令，都必须先过这道门。

#### 核心公式（看懂这一段就懂全文件）

三个 `ensure*` 函数都是同一个套路：

```ts
async ensureXxx(...) {
  if (在 cwd 里 / 不危险)     return    // 不需要检查
  if (在拒绝缓存里)           throw     // 之前说过不行
  if (在允许缓存里)           return    // 之前说过可以
  弹框问用户
  根据用户回答存缓存
  return 或 throw
}
```

整个文件 500 行，核心逻辑就这 6 行。其他全是辅助代码（Set 声明、危险命令判断、持久化、路径工具）。

#### 三个入口对应三类操作

| 函数 | 触发场景 | 第 1 步跳过条件 | 用哪些缓存 |
|------|---------|---------------|----------|
| `ensurePathAccess` | 访问 cwd 以外的路径 | 路径在 cwd 里 → 直接放行 | `*Paths` / `*DirectoryPrefixes` |
| `ensureCommand` | 执行命令 | 不是危险命令 → 直接放行 | `*Commands` / `*CommandPatterns` |
| `ensureEdit` | 写入/修改文件 | (无) | `*Edits` / `*EditPatterns` + `turn*` |

#### 三层记忆（缓存的核心设计）

```
turn     最短  ← 一轮对话结束就清空（beginTurn/endTurn 触发 .clear()）
session  中等  ← 程序运行期间有效，关掉就消失（普通 JS 变量）
always   永久  ← 写进 ~/.mini-code/permissions.json，重启也还在
```

**注意：不是 Redis 也不是数据库**，"内存"在这里就是字面意思——`PermissionManager` 类里的 `Set<string>` 变量。三层缓存对应三种不同的"寿命"。

**变量命名规律**：

```
[session/turn/(无)] + [Allowed/Denied] + [Paths/Commands/Edits/...]
       ↑                    ↑                    ↑
    寿命              允许还是拒绝          管的是什么
```

- **没前缀** = 永久（从文件加载）
- **有前缀** = 临时（程序内存）

#### 为什么 turn 级别只给 edits

Path / Command 没有 `turn*` 变量，因为这两类访问没那么频繁，session 粒度就够了。

**但文件编辑特别频繁**——AI 一轮对话里可能改 5 个文件，每改一个都问就太烦。所以专门给 edit 加了 `turn` 级别和 `turnAllowAllEdits` 一键全允许。

#### `deny_with_feedback` 的巧妙之处

这是 7 种决策里最有想法的一个。普通的 `deny_once` 只是抛错"拒绝了"——AI 收到这个错误就知道"失败了"，但**不知道为什么失败、应该怎么改**。

`deny_with_feedback` 的流程：

```
用户拒绝 + 写一段反馈："不要用 console.log，应该用 logger"
        ↓
PermissionManager 把反馈作为错误信息抛出
        ↓
agent-loop 把错误信息作为 tool_result 塞回 messages
        ↓
AI 看到反馈 → 调整方案 → 重新生成代码
```

**这是把"用户拒绝"变成了"AI 学习的反馈"**，比简单 deny 智能得多。

#### 一个完整例子串起来

AI 想读 `/Users/xxx/notes/test.md`（cwd 是 `/MiniCode`）：

```
1. 等初始化完成（this.ready）
2. 标准化路径
3. 在 cwd 里? → 不在
4. 在拒绝缓存里? → 没有
5. 在允许缓存里? → 没有
6. 有 prompt 函数? → 有
7. 算授权范围 → scopeDirectory = "/Users/xxx/notes"（父目录）
8. 弹框问用户
9. 用户按 'a'（allow this directory）
10. allowedDirectoryPrefixes.add("/Users/xxx/notes")
11. 写入 permissions.json
12. return（放行）

之后 AI 读 /Users/xxx/notes/another.md：
1-3. 同上
4. 不在拒绝缓存里
5. matchesDirectoryPrefix → 在 /Users/xxx/notes 白名单里
6. return（直接放行，不再问）
```

**关键设计：永久允许时存的是父目录（前缀），不是单个文件**。这样一次授权管一整片，避免重复打扰用户。

#### Trade-off

**Trade-off 1 — 三层缓存 vs 单一缓存**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：turn / session / always 三层** | 用户能精确控制授权范围 | 7 种决策选项稍多 |
| 单层（要么这次要么永远） | 简单 | 用户被迫在"烦死"和"不安全"之间二选一 |

选当前方案的原因：编辑场景下"本轮全部允许"是最舒服的体验——既不用每次问，又不会永久失控。

**Trade-off 2 — 永久授权存父目录 vs 存单个路径**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：存父目录前缀** | 一次授权管一片，重复访问不再问 | 授权范围比预期大 |
| 只存被询问的具体路径 | 范围精确 | 同目录下其他文件还是要问 |

选当前方案的原因：用户的真实意图通常是"信任这个目录"，不是"信任这一个文件"。

**Trade-off 3 — `deny_with_feedback` vs 简单 deny**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：拒绝 + 反馈给 AI** | AI 能根据反馈调整方案，把"失败"变成"对话" | 实现稍复杂（要把错误信息塞回 messages） |
| 简单 deny | 实现简单 | AI 失败后不知道怎么改，只能重试一样的方案 |

选当前方案的原因：让用户和 AI 形成"协作关系"而不是"主仆关系"——用户拒绝时给出指导，AI 立刻调整，比反复试错高效得多。

#### 你需要记住的就 3 件事

1. **核心套路**：查缓存 → 没有就问 → 记住答案
2. **三层缓存**：turn / session / always，对应不同寿命
3. **`deny_with_feedback`**：把拒绝变成反馈，让 AI 学习

其他细节（Set 操作、persist 写文件、路径标准化）都是辅助实现，看不懂不影响使用。

---

### 4.6 配置系统（config.ts — 248 行）

多层配置的加载与合并。

**配置优先级（从高到低）：**
```
1. ~/.mini-code/settings.json    ← 用户全局设置（最高优先级）
2. ~/.mini-code/mcp.json         ← 用户 MCP 配置
3. ./.mcp.json                   ← 项目目录下的 MCP 配置
4. ~/.claude/settings.json       ← 兼容 Claude Code 的配置
5. 环境变量                       ← ANTHROPIC_API_KEY 等
```

**输出的 RuntimeConfig：**
```typescript
{
  model: string         // 模型名（必填）
  baseUrl: string       // API 端点（默认 https://api.anthropic.com）
  authToken?: string    // Bearer token
  apiKey?: string       // x-api-key
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>  // MCP 服务器配置
}
```

**为什么要多层合并：** 让用户可以在不同层级设置不同的东西。全局设置放 API key，项目级设置放这个项目专用的 MCP 服务器。

#### 学习要点速览（一句话掌握）

> **`config.ts` = 配置加载器**：从 4 个文件 + 环境变量收集配置，合并成一个 `RuntimeConfig` 对象，给整个项目用。

**4 个文件来源**：

| # | 文件位置 | 通常放什么 | 适用范围 |
|---|---------|----------|---------|
| 1 | `~/.claude/settings.json` | 兼容 Claude Code 的旧设置 | 全局 |
| 2 | `~/.mini-code/mcp.json` | 全局 MCP 服务器列表 | 全局 |
| 3 | `./.mcp.json` | 项目专用 MCP 服务器（**跟 git 走**） | 单个项目 |
| 4 | `~/.mini-code/settings.json` | mini-code 主配置（模型、API key） | 全局 |

**为什么要拆这么多文件**：因为它们的"分享范围"不同——API key 这种秘密只能放家目录不能进 git；项目要的 MCP 工具应该跟项目走，clone 就能用。所以 `./.mcp.json` 和 `~/.mini-code/settings.json` 必须分开。

**核心思想**：多层合并 + 优先级覆盖。**越具体的配置越优先**（环境变量 > 项目配置 > 全局配置）。和 prompt.ts 里 CLAUDE.md 的两层加载是**完全一样的思想**。

**唯一需要记住的入口函数**：`loadRuntimeConfig()`
- `index.ts` 启动时调一次
- 内部流程：读所有配置 → 合并 → 解析 model → 推断 baseUrl → 找 API key → fail-fast 校验
- 返回 `RuntimeConfig` 对象,传给所有需要配置的地方

其他函数（`mergeSettings`、`loadEffectiveSettings` 等）都是助手,理解时不需要记。

#### 几个值得理解的设计细节

**1. 用 model 名前缀自动推断 baseUrl**

用户只需要写 `model: "gemini-2.5-flash"`，系统自动选 Google 的端点。设计原则：**让用户表达意图，实现细节由系统补全**。同时留逃生口——环境变量 `ANTHROPIC_BASE_URL` 可手动覆盖（用于本地 Ollama / LiteLLM 代理）。

**2. API key 按顺序尝试多个 env 变量名**

不强制用户用统一名字，按顺序尝试 `ANTHROPIC_API_KEY → GEMINI_API_KEY → OPENAI_API_KEY → DEEPSEEK_API_KEY`。设计原则：**接受用户已有的习惯**比要求改习惯友好。

**3. Fail-fast 校验**

`loadRuntimeConfig` 结束前检查 `model` 和 `apiKey` 都存在，没有就立刻抛错。**不让错误延迟到第一次调 LLM 才出现**——那种错更难定位。

**4. `mergeSettings` 的深合并**

不是粗暴的整对象覆盖，而是分字段深合并：普通字段（model）→ 覆盖；env / headers / mcpServers → 字典深合并（保留 base 的 key，叠加 override 的 key）。这样用户在不同层级只需要写"差异部分"，不用每层都重写完整配置。

#### Trade-off

**Trade-off 1 — 多文件分层 vs 单一配置文件**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：4 个文件 + 环境变量** | 不同分享范围分开存（个人 vs 项目）；秘密不会进 git | 用户要理解优先级 |
| 单一配置文件 | 简单直观 | 项目配置和秘密混在一起；多项目共享困难 |

选当前方案的原因：API key 不能进 git，但项目 MCP 配置应该进 git，必须分开存。

**Trade-off 2 — 自动推断 baseUrl vs 用户必填**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：从 model 名前缀推断** | 用户只填 model 就能跑；80% 用户开箱即用 | 实现里要枚举所有 provider 前缀 |
| 强制用户填 baseUrl | 实现简单 | 用户体验差，容易配错 |

选当前方案的原因：`model + baseUrl` 是冗余信息——99% 情况下选了 model 就决定了 baseUrl。

**Trade-off 3 — Fail-fast vs 静默继续**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：启动时校验，缺 model/key 直接抛** | 错误尽早暴露，定位容易 | 用户没配的话连 TUI 都进不去 |
| 静默继续，调 LLM 时再失败 | 用户能看到 TUI | 错误延迟，用户输入半天才知道根本没法用 |

选当前方案的原因：缺 API key 是**完全无法恢复**的错误，越早暴露越好。

---

### 4.7 System Prompt（prompt.ts — 114 行）

组装发给 LLM 的 system prompt，告诉它：
- 你是谁（身份声明）
- 当前工作目录是哪
- 有哪些权限规则
- 有哪些可用的 skill
- 有哪些 MCP 服务器已连接
- 用户的全局指令（`~/.claude/CLAUDE.md`）
- 项目级指令（`./CLAUDE.md`）
- 响应协议：用 `<progress>` 表示"还在做"，用 `<final>` 表示"做完了"

#### 核心概念：动态上下文（Dynamic Context）

**反面案例（静态 prompt）：**
```ts
const SYSTEM_PROMPT = "You are NordicBot. cwd is /xxx. Skills: a, b, c."
```
写死在常量里，无法反映运行时的真实状态——cwd 会变、skill 会被加载、MCP 会连接、CLAUDE.md 会被编辑。

**当前方案（动态 prompt）：** `buildSystemPrompt()` 是个**函数**，每轮对话发起前都被调用一次（`refreshSystemPrompt()`），把"此刻"的状态打包成一段文字塞回 `messages[0]`。

实现三步：
1. **把会变的东西做成参数**：`cwd`、`permissionSummary`、`skills`、`mcpServers` 都作为参数传入，没有任何全局状态
2. **调用前现场采集**：`tty-app.ts:490` 的 `refreshSystemPrompt()` 通过 getter（`permissions.getSummary()`、`tools.getSkills()`、`tools.getMcpServers()`）现场拿最新值，不用缓存
3. **覆盖 messages[0]**：直接把生成的字符串塞回消息数组的第 0 位，下次发给 LLM 就是最新的

**核心思想：prompt 不是数据，是"快照"**——每次拍一张当前世界的照片发给模型。

#### 核心概念：两层 CLAUDE.md 加载

**为什么要两层：**
- **全局**（`~/.claude/CLAUDE.md`）：所有项目共享的偏好（如"用中文回答"、"提交按 conventional commits"）
- **项目**（`./CLAUDE.md`）：项目专属规则（如"这个项目用 React 18"、"禁止使用 lodash"）

如果只能写一份，每个项目都要重写一遍全局偏好。

**实现要点：**

```ts
const globalClaudeMd = await maybeRead(
  path.join(os.homedir(), '.claude', 'CLAUDE.md')
)
const projectClaudeMd = await maybeRead(
  path.join(cwd, 'CLAUDE.md')
)
```

- `os.homedir()` 而不是写死路径 → 跨用户跨电脑可用
- `path.join()` 而不是字符串拼接 → 跨平台（Mac/Linux 用 `/`，Windows 用 `\`）
- `maybeRead()` 把"文件不存在"翻译成"返回 null"，避免可选文件抛异常打断启动

**优先级是怎么实现的（反直觉）：** 代码里**没有**任何"覆盖"逻辑，两份内容都被原样拼进 prompt。"项目覆盖全局"靠的是**LLM 自身对"后出现指令"更敏感**的注意力机制——所以代码里只需要"先 push 全局，后 push 项目"，剩下的语义由 LLM 自己处理。

这是"**能用 prompt 表达的规则就别写代码**"的典型例子。

#### 关键 prompt 条款（决定 agent 性格的几行字）

| 条款 | 作用 | 删掉会怎样 |
|------|------|-----------|
| `Default behavior: inspect/use tools/make changes...` | 让 agent 主动动手 | 退化成话痨 |
| `If user asked to build/modify, do the work instead of stopping at a plan` | 防止"光做计划不动手" | 经常停在"我建议这样做..." |
| `<progress>` / `<final>` 协议 | 控制 agent loop 的继续/终止 | loop 经常早死 |
| `ask_user 必须用工具，不能用纯文本` | 防止纯文本提问被当成 final 而终止循环 | 提问后无法继续 |
| `read_file 注意 TRUNCATED 标记` | 防止误判文件被截断 | 大文件读不全 |

#### Trade-off

**Trade-off 1 — 刷新策略：每轮刷新 vs 启动时一次**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：每轮刷新 `refreshSystemPrompt()`** | MCP 工具延迟加载、CLAUDE.md 实时编辑都能反映 | 每轮多一次构建（但很快） |
| 启动时构建一次 | 实现简单，零开销 | 启动后任何动态变化 AI 都不知道 |

选当前方案的原因：MCP 异步连接、用户会在会话中编辑 CLAUDE.md，必须保证 LLM 看到的是"此刻"的状态。

**Trade-off 2 — 用数组拼接 vs 用字符串模板**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：`parts: string[]` + `join('\n\n')`** | 条件添加方便（`if (skills) parts.push(...)`）；每段独立可注释 | 比字符串模板多写一行 push |
| 单个大字符串模板 | 视觉上更直观 | 条件分支难处理；调试困难 |

选当前方案的原因：prompt 里有大量"有就加，没有就跳过"的动态段落（权限/skill/MCP/CLAUDE.md），数组结构天然适配条件追加。

**Trade-off 3 — CLAUDE.md 优先级用代码控制 vs 用 prompt 顺序控制**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：靠 prompt 顺序（先全局后项目）让 LLM 自己解决冲突** | 零代码逻辑；用户可以加任意层而不用改代码 | 依赖 LLM 注意力机制，理论上不"硬保证" |
| 代码里 diff/merge 两份内容 | 行为可预测 | 实现复杂；规则冲突难定义 |

选当前方案的原因：Claude Code 风格的核心思想就是"**用自然语言而不是代码描述规则**"，让 prompt 本身成为可读的契约。

**Trade-off 4 — `maybeRead` 把异常变成 null vs 抛出**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **当前：try/catch 返回 null** | CLAUDE.md 可选，没写也能跑 | 隐藏了"权限错误"这种真异常 |
| 直接让 `readFile` 抛 | 错误更显式 | 用户没写 CLAUDE.md 就崩溃，体验差 |

选当前方案的原因：CLAUDE.md 的语义就是"可选配置"，"没写"和"读不到"在用户视角是一回事，简化处理是合理的。

---

### 4.8 文件审查（file-review.ts — 70 行）

每次 LLM 要写入或修改文件时，先生成一个 unified diff（跟 `git diff` 一样的格式），然后通过权限系统让用户 review。

用了 `diff` 库（唯一的两个运行时依赖之一）来生成 diff。

**流程：** 读旧文件 → 生成 diff → `permissions.ensureEdit()` 让用户确认 → 写入文件。

---

### 4.9 工作区路径解析（workspace.ts — 28 行）

所有工具访问文件系统时，都经过 `resolveToolPath()` 统一解析路径：
1. 把相对路径转成绝对路径
2. 检查是否越界（超出 cwd）
3. 如果有权限管理器，走 `ensurePathAccess()` 审批

---

### 4.10 MCP 客户端（mcp.ts — 1277 行）

**MCP（Model Context Protocol）** 是一个让 LLM 连接外部工具的标准协议。

**已实现两种传输方式：**

| 方式 | 类 | 适用场景 |
|------|---|---------|
| stdio | `StdioMcpClient` | 本地进程（如 `npx @modelcontextprotocol/server-filesystem`） |
| streamable-http | `StreamableHttpMcpClient` | 远程 HTTP 端点 |

**stdio 协议自动协商：**
1. 先尝试 `Content-Length` 帧格式（MCP 标准）
2. 超时后尝试换行分隔 JSON 格式
3. 成功后缓存到 `~/.mini-code/mcp-protocol-cache.json`，下次直接用

**MCP 工具注册流程：**
```
启动 MCP 服务器进程
  → JSON-RPC initialize 握手
  → tools/list 获取工具列表
  → 每个工具包装成 mcp__<server>__<tool> 格式
  → 注入 ToolRegistry
```

**额外功能：** 如果 MCP 服务器发布了 resources 或 prompts，还会自动注册 `list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt` 四个辅助工具。

---

### 4.11 Skill 系统（skills.ts — 219 行）

Skill 是一种本地工作流指令，用 `SKILL.md` 文件描述。

**搜索路径（按优先级）：**
```
1. ./.mini-code/skills/<name>/SKILL.md    ← 项目级
2. ~/.mini-code/skills/<name>/SKILL.md    ← 用户级
3. ./.claude/skills/<name>/SKILL.md       ← 兼容 Claude Code 项目级
4. ~/.claude/skills/<name>/SKILL.md       ← 兼容 Claude Code 用户级
```

同名 skill 优先使用高优先级路径的版本。

**管理命令：**
```bash
minicode skills list                              # 列出已发现的 skill
minicode skills add ~/path/to/skill --name myskill  # 安装
minicode skills remove myskill                     # 卸载
```

---

### 4.12 内置工具详解

#### 文件操作工具

| 工具 | 文件 | 行为 |
|------|------|------|
| `read_file` | read-file.ts | 读文件，默认最多 8000 字符，支持 offset/limit 分页。超出部分标记 `TRUNCATED: yes` |
| `write_file` | write-file.ts | 写新文件，经过 `applyReviewedFileChange()` → 生成 diff → 用户确认 → 写入 |
| `edit_file` | edit-file.ts | 精确替换：在文件中找到 `search` 字符串，替换为 `replace`。找不到则报错 |
| `modify_file` | modify-file.ts | 整文件替换，经过 diff review。跟 `write_file` 行为相同 |
| `patch_file` | patch-file.ts | 批量替换：一次传多组 search/replace，按顺序依次执行。任何一组找不到就中止 |

#### 搜索工具

| 工具 | 文件 | 行为 |
|------|------|------|
| `list_files` | list-files.ts | `readdir()` 列目录，标记 `dir`/`file`，最多 200 条 |
| `grep_files` | grep-files.ts | 调用 `rg`（ripgrep）搜索文件内容 |

#### 元数据工具

| 工具 | 文件 | 行为 |
|------|------|------|
| `count_lines` | count-lines.ts | 数一个 UTF-8 文本文件的行数。返回 `FILE: ...\nLINES: N`。设计目的：让 LLM 不用 read_file 把整个文件塞进 context 也能拿到行数，把 O(文件大小) 的 token 开销压成 O(1) |

#### 命令执行

| 工具 | 文件 | 行为 |
|------|------|------|
| `run_command` | run-command.ts | 执行 shell 命令，详见下方 |

**run_command 的安全机制：**
- **白名单：** 只允许 `pwd`/`ls`/`git`/`npm` 等预设命令，其他命令触发审批
- **只读命令：** `pwd`/`ls`/`grep` 等不需要任何审批
- **开发命令：** `git`/`npm`/`node` 等需要经过危险检测
- **shell 管道：** 如果命令包含 `|`/`&`/`;` 等符号，自动通过 `bash -lc` 执行
- **后台任务：** 如果命令以 `&` 结尾，detach 运行并注册到 `background-tasks.ts`

#### 交互工具

| 工具 | 文件 | 行为 |
|------|------|------|
| `ask_user` | ask-user.ts | 向用户提问。返回 `awaitUser: true` 让 agent loop 暂停，等用户回复 |
| `load_skill` | load-skill.ts | 加载指定名称的 SKILL.md 全部内容，喂回 LLM |

#### 网络工具

| 工具 | 文件 | 行为 |
|------|------|------|
| `web_search` | web-search.ts | 搜索引擎查询。先试 DuckDuckGo Lite，失败后回退搜狗。支持域名过滤 |
| `web_fetch` | web-fetch.ts | 抓取网页，自动提取可读文本（去掉 script/style/HTML 标签），默认最多 12000 字符 |

**web_search 的双引擎设计：** DuckDuckGo 在国内可能不通，搜狗作为兜底。两个引擎都是直接爬 HTML 解析结果，不需要 API key。

---

### 4.13 TUI 界面系统

**两种运行模式：**
- **TTY 模式**（`tty-app.ts`）：检测到交互式终端时启用。全屏界面，有 banner、对话面板、输入框、状态栏
- **非 TTY 模式**（`index.ts` 中的 readline 循环）：管道或非交互终端使用，纯文本输入输出

**TTY 模式的界面布局：**
```
┌─────────── banner ──────────────┐  ← 项目名、模型、配置来源
├─────────── transcript ──────────┤  ← 对话记录（用户/助手/工具调用）
├─────────── prompt ──────────────┤  ← 输入框 + slash 命令菜单
└─────────── footer ──────────────┘  ← 状态栏
```

**TranscriptEntry 类型（对话记录条目）：**
- `user` → 用户消息
- `assistant` → LLM 最终回复
- `progress` → LLM 中间进度
- `tool` → 工具调用（有 running/success/error 状态，完成后自动折叠）

**TUI 的特殊交互：**
- 权限审批弹窗（Up/Down 选择 + Enter 确认，或直接按快捷键）
- diff 预览（`Ctrl+O` 展开/折叠）
- slash 命令自动补全菜单
- 输入历史（上下方向键）
- 对话记录滚动（滚轮/PgUp/PgDn）

**全部用 ANSI 转义码手写：** 没有用 Ink 或 blessed 等 TUI 框架，直接控制终端输出。

---

### 4.14 管理命令系统（manage-cli.ts — 290 行）

当你运行 `minicode mcp ...` 或 `minicode skills ...` 时，`index.ts` 入口会先检测是否是管理命令（通过 `maybeHandleManagementCommand()`），如果是就直接处理，不启动交互循环。

```bash
# MCP 管理
minicode mcp list [--project]
minicode mcp add <name> [--project] [--protocol <mode>] [--url <url>] [--header K=V] [--env K=V] [-- <command> [args]]
minicode mcp remove <name> [--project]
minicode mcp login <name> --token <token>
minicode mcp logout <name>

# Skill 管理
minicode skills list
minicode skills add <path> [--name <name>] [--project]
minicode skills remove <name> [--project]
```

---

### 4.15 Mock 模式（mock-model.ts — 179 行）

设置环境变量 `MINI_CODE_MODEL_MODE=mock` 后，不需要 API key 就能运行。

Mock adapter 硬编码了一些 slash 命令的响应：
- `/ls` → 调用 `list_files`
- `/read <path>` → 调用 `read_file`
- `/cmd <command>` → 调用 `run_command`
- 其他输入 → 返回提示文本

**用途：** 测试 TUI 界面和工具执行流程，不消耗 API 额度。

---

### 4.16 用量统计（usage-tracker.ts）

#### 一句话定位

> **`usage-tracker.ts` = 一个共享小本子**。adapter 在每次 LLM 调用结束后写入一笔账单，`/cost` 命令在被触发时读出累计值。两个互不认识的模块通过这个中立模块交换数据。

#### 解决的问题

加 `/cost` 命令时遇到一个跨模块协作问题：
- **数据产生方**：`gemini-adapter.ts`，每次响应里都有 `usageMetadata`（账单）
- **数据使用方**：`cli-commands.ts`，用户输入 `/cost` 时要展示累计值

让两个模块直接对话会造成耦合（adapter 不该知道斜杠命令的存在，反之亦然）。引入第三方中立模块解决——adapter 只负责"写"，cli-commands 只负责"读"，互不见面。

#### 设计要点

| 决策 | 选择 | 理由 |
|------|------|------|
| 状态存储 | 模块级单例（`let records: UsageRecord[]`） | mini-code 是单进程 CLI，不需要 IoC 容器 |
| 状态更新 | `records = [...records, x]`，不用 `push` | 保持 immutable update，旧快照不受新写入影响 |
| 写入/读取类型分离 | `UsageRecord`（写）+ `UsageTotals`（读） | 两边的关注点不同，类型即接口 |
| 价格表 | 写死在模块内部，不 export | 实现细节，外面只看到最终 `estimatedCostUsd` |
| 模型名匹配 | `startsWith` 模糊匹配 | 兼容带后缀的版本名（gemini-2.5-flash-001） |
| 字段缺失处理 | `?? 0`，不报错 | 辅助功能要"有结果"，不要因为某个字段缺失就崩 |
| 价格表外的模型 | 用默认价格（Flash），不报错 | 估算 > 准确，标注 `~` 表示估算 |

#### 公开 API

```ts
recordUsage(record: UsageRecord): void   // adapter 调，记一笔
getUsageTotals(): UsageTotals            // /cost 调，读累计
resetUsage(): void                        // /cost reset 调，清空
```

#### 数据流（端到端）

```
用户问问题
   ↓
gemini-adapter.next()
   ├─ 翻译消息 → 发 HTTP 请求
   ├─ 收响应 → 解析 candidates（主业）
   └─ 解析 usageMetadata → recordUsage(...)  ← 写入
                                ↓
                       usage-tracker
                       （records 数组累加）
                                ↑
用户输入 /cost                  │
   ↓                            │
cli-commands.tryHandleLocalCommand
   └─ formatUsageReport()
       └─ getUsageTotals()  ← 读取
```

**关键点：adapter 对外接口完全没变**——agent-loop 和上层代码完全不知道有 tracker 存在。这是"扩展开放、修改封闭"的实战写法。

#### 三家 adapter 的 usage 字段对照表

三家供应商都返回账单数据，但字段名和语义全都不一样。adapter 的一大职责就是**把各家的怪癖翻译成 tracker 的统一格式** `UsageRecord`。

| `UsageRecord` 字段 | Gemini (`usageMetadata.*`) | Anthropic (`usage.*`) | OpenAI (`usage.*`) |
|---|---|---|---|
| `inputTokens` | `promptTokenCount` | `input_tokens` | `prompt_tokens` |
| `outputTokens` | `candidatesTokenCount + thoughtsTokenCount` | `output_tokens` | `completion_tokens` |
| `cachedTokens` | `cachedContentTokenCount` | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| `model` | `modelVersion`（顶层字段） | `model`（顶层字段） | `model`（顶层字段） |

**重点差异**：

1. **"推理 token" 在哪里记**
   - Gemini 2.5 的 thinking token（`thoughtsTokenCount`）是**单独字段**，要手动加到 output 里
   - Anthropic 的 extended thinking token 已经**内含在** `output_tokens` 里
   - OpenAI 的 o1/o3 reasoning token 也已经**内含在** `completion_tokens` 里
   - 结论：三家里只有 Gemini 要做加法，另外两家直接取就行

2. **"缓存"字段的陷阱**
   - Anthropic 有两个缓存字段：`cache_creation_input_tokens`（写缓存，比普通 input 贵 25%）和 `cache_read_input_tokens`（读缓存，只要普通 input 的 10%）。**我们只把"读"算作 `cachedTokens`**——"写"按普通 input 记，否则成本估算会偏低
   - OpenAI 的缓存字段嵌套在 `prompt_tokens_details` 里，要用可选链 `?.` 访问
   - Gemini 的 `cachedContentTokenCount` 直接放顶层，最干净

3. **`input_tokens` 是不是已经去掉缓存？**
   - Anthropic：`input_tokens` **不包含** cache_read 部分（两个加起来才是总 input）
   - OpenAI：`prompt_tokens` **包含** cached_tokens（后者是前者的子集）
   - Gemini：`promptTokenCount` **包含** cachedContentTokenCount（后者是前者的子集）
   - 这直接影响 `calcCost()` 里算"非缓存 input"的逻辑。当前 tracker 的公式 `uncachedInput = inputTokens - cachedTokens` 只对 Gemini 和 OpenAI 正确；**对 Anthropic 偏低**。修正方式：Anthropic adapter 写入时，把 `inputTokens` 设成 `input_tokens + cache_read_input_tokens`，让后续公式统一

#### 当前局限

- **价格表是估算值**——硬编码在 `PRICE_TABLE` 里，模型版本更新后可能过时，所有金额都标 `~` 表示估算
- **会话级粒度**——除了 turn 级差值外，没有更细粒度（比如按工具调用分账）
- **Anthropic 写缓存（cache_creation）按普通 input 计价**，没有单独的"写缓存贵 25%"条目——这会让启用 prompt caching 的会话账单略微偏低

#### 扩展方向

新增 adapter 时的接入模板：
1. `import { recordUsage } from './usage-tracker.js'`
2. 在响应 JSON 类型里补上 `usage` + `model` 字段
3. 在 `if (!response.ok) throw` 之后、解析内容之前，调用 `recordUsage({ ... })`，按本节的对照表填字段
4. 在 `PRICE_TABLE` 里加入新模型的价格条目

#### Turn 级粒度（已规划）

`/cost` 当前只显示 session 累计。用户经常想知道**刚才那一句话**花了多少——这是一个比 session 更细、比 call 更粗的粒度，称为 turn。

##### 三种粒度

| 粒度 | 边界 | 包含 |
|---|---|---|
| session | 启动 → 退出 | 多个 turn |
| **turn** | 用户按一次回车 → AI 答完 | 1+ 个 call |
| call | 一次 HTTP 往返 | 一次响应 |

##### 设计：快照差值模式

不给每条 record 打 turn 标签，而是在 turn 开始时拍一张"当前累计快照"，查询时用"当前累计 - 快照"得到这一轮的消耗。

为什么用快照差值而不是给每条 record 打 turn 标签：
- **改动小**：tracker 内部只多一个变量（`turnStartSnapshot`），records 数组结构不变
- **写入路径不动**：adapter 调 `recordUsage` 时完全不需要知道 turn 概念
- **跟现有抽象对齐**：和 `permissions.beginTurn()` 是同一个模式，认知负担小

##### 新增 API

```ts
beginTurn(): void              // index.ts 主循环在每条用户输入前调
getTurnUsage(): UsageTotals    // /cost 调，返回 "当前 - 快照" 的差值
```

`endTurn()` 不需要——turn 没有"结束"的概念，下一个 `beginTurn()` 会覆盖快照。

##### 改动范围

| 文件 | 改什么 |
|---|---|
| `usage-tracker.ts` | 加快照变量 + 两个新 API |
| `index.ts` | 主循环里在 `permissions.beginTurn()` 旁边调 `usageTracker.beginTurn()` |
| `cli-commands.ts` | `/cost` 同时显示 "Last turn" 和 "Session total" 两块 |

注意 **adapter 完全不动**——turn 概念只在写入和读取的"边界"上，写入路径无感。

##### `/cost` 新输出格式

```
Last turn:
  LLM calls:       3
  Input tokens:    4,521 (1,200 fresh + 3,321 cached, 73% hit rate)
  Output tokens:   42
  Estimated cost:  ~$0.000178

Session total:
  LLM calls:       7
  Input tokens:    9,832 (...)
  ...
```

##### 边界情况

- **session 第一条消息之前** → Last turn 显示 "No calls in current turn yet."
- **用户连发两次 `/cost`** → Last turn 仍然显示上一个 turn 的差值（快照没动）
- **`/cost reset`** → 同时清空 records 和 snapshot

---

### 4.17 上下文压缩（context-compactor.ts — 设计规划中）

**状态**：🚧 规划中，实现方案待决。本节在 Socratic 对话过程中逐步累积设计约束和决策。

#### 一句话定位

> **将过长的 `messages: ChatMessage[]` 压缩成更短的版本，同时保证下一次 `model.next()` 调用仍然合法可用。**

#### 问题背景

当会话变长，`messages` 数组会无限增长。三个后果同时发生：

1. **成本爆炸**：LLM 是无状态的，每次调用都要重发整个历史。100k token 输入 × $15/M ≈ $1.5 一次，20 轮就是 $30
2. **延迟恶化**：输入越长，首 token 延迟越高
3. **Lost in the Middle**：中间段的 token 召回率下降——这不是 attention 的 bug，是训练数据先验（首尾重要、中间填充）让模型学到的偏见。softmax 稀释进一步加剧：上下文从 1k 到 100k，关键 token 的有效权重被稀释 100 倍

**关键观察**：扩大 context window（Claude 200k、Gemini 1M）**不解决这个问题**，只是把「崩溃」变成「贵且笨」。

#### 🔒 铁律 #1：消息数组的配对约束

**这是任何压缩策略的第一红线。**

`ChatMessage[]` 不是线性序列，是**带配对约束的序列**：

```
assistant_tool_call(toolUseId='abc') ──┐
                                       ├─ 硬绑定，不能拆
tool_result(toolUseId='abc')       ────┘
```

Anthropic / OpenAI / Gemini **三家 API 都在协议层强制这条约束**。Anthropic 的错误信息最直白：

```
HTTP 400: tool_result block found with no preceding tool_use block
```

**为什么 API 要这么严？**（两层原因）

1. **协议无歧义**：function calling 必须是"请求-响应"原子事务。半成品 = 无意义 = 拒绝
2. **防幻觉**：如果允许孤儿 `tool_result`，LLM 会幻觉出一个不存在的工具调用上下文，自己编造"我刚才调了什么、为什么调"。这对 agent 是灾难——每一步都依赖前一步的真实结果，一次幻觉会污染后续所有决策

**工程原则**：**Fail loud, fail fast**。API 选择拒收，而不是让下游在无意义状态下继续跑。

#### 🎯 对压缩策略的约束

铁律 #1 直接淘汰或约束了多个方案：

| 朴素策略 | 为什么出问题 |
|---|---|
| `messages.slice(-K)` 滑动窗口 | ❌ 按索引切，可能正好切在配对中间 |
| 随机丢弃"不重要"的消息 | ❌ 可能丢掉配对的一半 |
| 按角色过滤（比如只留 user + assistant） | ❌ 扔掉 tool_result 后 tool_call 变孤儿 |

**任何合法的压缩函数必须满足的不变式**：

> 对所有存在的 `assistant_tool_call(id=X)`，输出数组里**要么同时包含对应的 `tool_result(id=X)`**，**要么两者都不包含**。

#### 🧰 哪些消息可以被安全摘要？3 维决策框架

判断一条 `tool_result` 能不能被摘要掉，**不是只看"有没有副作用"**，而是 3 个维度的组合：

| 维度 | 问题 | 影响 |
|---|---|---|
| **1. 可重放性** | 再调一次能拿到同样结果吗？ | 可重放 = 可摘要（需要时重跑） |
| **2. 副作用落地** | 副作用有没有在外部系统留下痕迹？ | 副作用已持久化 = 可摘要（痕迹就是记忆） |
| **3. 结果是否是唯一记录** | 这条消息是不是某个信息的唯一来源？ | 是 = **绝对不能摘要** |

**反直觉观察**：「有副作用」反而让工具**更容易**被摘要。比如 `write_file`——它的副作用就在文件系统里，之后 `read_file` 能随时重读当前内容。摘要掉旧的 `write_file` 结果没关系。

**真正危险的是 `ask_user`**：它没有副作用，但 `tool_result` 里用户的回答是**唯一记录**，摘要掉 = 永久丢失用户原话。

#### MiniCode 工具的摘要安全性分类

| 工具 | 可重放 | 副作用落地 | 摘要策略 |
|---|---|---|---|
| `read_file` | ✅ | - | ✅ 可摘要（需要时重读） |
| `list_files` | ✅ | - | ✅ 可摘要 |
| `grep_files` | ✅ | - | ✅ 可摘要 |
| `write_file` | ✅ | ✅ 在磁盘 | ✅ 可摘要 |
| `edit_file` / `patch_file` / `modify_file` | ✅ | ✅ 在磁盘 | ✅ 可摘要 |
| `run_command` | ⚠️ 看命令 | ⚠️ 看命令 | ⚠️ **保守策略：留原文**（见安全名单） |
| `web_fetch` | ⚠️ 内容可能变 | - | ⚠️ 通常留原文 |
| `web_search` | ❌ 结果随时间变 | - | ❌ 留原文 |
| `ask_user` | ❌ | - | ❌❌ **绝对留原文**——用户答案是唯一记录 |
| `load_skill` | ✅ | - | ✅ 可摘要 |

#### 💰 压缩的经济学：两种成本

压缩一条大 `tool_result`，你面对**两种不同性质的成本**：

**成本 A：保留成本（确定的）**

如果不压缩，原文每次调用都要重发：
```
cost_keep = K × R
```
- `K` = 剩余对话轮数
- `R` = 原文 token 数
- **确定付**——不管后续用不用，都要付

**成本 B：重放成本（条件的）**

如果压缩：
```
cost_compress = S × K + P × R
```
- `S` = 摘要 token 数（≪ R）
- `P` = 未来真的需要这段信息的概率
- **只在 LLM 真的需要时才付 `P × R`**

**压缩划算的条件**：
```
S × K + P × R  <  K × R
↓
P  <  K × (R - S) / R
```

**翻译成直觉**：
- `R` 越大（原文越大），压缩越划算——因为 `K × R` 滚雪球
- `K` 越大（剩余轮数越多），压缩越划算——保留成本线性增长
- `P` 越小（被再次引用概率越低），压缩越划算

**关键结论**：**大的 `tool_result` 几乎总是该被压缩**——因为保留它的代价随对话轮数线性增长，滚雪球。小的 `tool_result` 反而不值得压缩，因为省的 token 连摘要本身都抵不掉。

##### 成本速查表（面试备忘）

Claude Sonnet 4.x 的典型价位作为基准（$3/M input，$15/M output）：

| 输入 token | 单次调用成本 | 20 轮累计成本 | 建议动作 |
|---|---|---|---|
| 30k（≈15%） | ~$0.09 | ~$1.80 | 🟢 无需压缩 |
| 60k（≈30%） | ~$0.18 | ~$3.60 | 🟢 继续观察 |
| 120k（≈60%） | ~$0.36 | ~$7.20 | 🟡 **Tier 1 触发**（60% 阈值）|
| 174k（≈87%） | ~$0.52 | ~$10.44 | 🔴 **Tier 2 触发**（87% 阈值）|
| 190k（≈95%） | ~$0.57 | ~$11.40 | 🚨 **Tier 3-Lite + 强提示** |

**用这张表答面试题**：
- Q: "30k vs 150k 成本差多少？" → A: "单次调用差 5 倍（$0.09 vs $0.45），20 轮累计差 $7.20"
- Q: "什么时候应该手动 /compact？" → A: "在 Tier 1 能处理的 60~87% 区间不需要；超过 87% 系统会自动触发 Tier 2；但如果你知道某轮之后会聊很久，在 60% 就手动 /compact 能节省后续的 `K × R` 滚雪球成本"

**注意**：这些数字会过期（价格会变），但**数量级不会**——这是为什么压缩不是可选项。

#### 🎲 核心难题：P 的不可知性

上面的公式看起来很工程化，但有一个字段**你根本无法精确知道**——`P`，未来引用这段信息的概率。

- 用户刚才让你读了 `config.ts`——他下一句是要你改 port？聊别的？你不知道
- 用户刚才 grep 了一个关键字——他会追问细节吗？你不知道
- 这个 tool_result 是关键信息还是噪音？**你不知道**

**这才是上下文压缩的真正困难**：

> **压缩策略的本质不是"算法怎么实现"，而是"你如何预测 P"。所有策略都是对 P 的某种启发式估计。**

#### 5 种策略对 P 的假设

| 策略 | 对 P 的假设 | 代表实现 |
|---|---|---|
| **滑动窗口** | P 随时间衰减——近期 P 高，远期 P 低 | LangChain `BufferWindowMemory` |
| **纯摘要** | 所有原始细节 P 都很低，只有语义结论重要 | LangChain `SummaryMemory` |
| **摘要 + 近窗混合** | 近期 P 高（保留原文），远期 P 低（摘要） | **Claude Code `/compact`**, Cursor auto-summary |
| **按工具类型（幂等性）** | P 由工具类型决定，与语义无关 | 未见成熟工业实现 |
| **LLM 自判断** | 外包 P 的估计——让 LLM 读对话自己决定 | Claude Code 的摘要 prompt 内部就是这么做的 |

**关键洞察**：**Claude Code 的聪明在于把 P 估计外包给 LLM 本身**。它不写死规则，而是让摘要过程中的 LLM 读对话内容，自己判断"这段对后续重要吗"——重要的留在摘要里，不重要的扔掉。

这等于**用 LLM 的语义理解能力替代了人类写死的启发式**。

#### ✅ 选型决定：三层架构（Tier 1 + Tier 2 + Tier 3）

**决策依据**：2025 年 Claude Code 部分源码泄露后，社区整理出其上下文管理系统的真实结构。本节直接对齐其架构作为 MiniCode 的实施蓝本。参考：[Claude Code Complete Guide — Part 8: Context Management](https://bcefghj.github.io/claude-code-complete-guide_v2/part08-context-management/)

**核心洞察**：**不同强度的压缩对应不同成本**。瀑布式递进——先尝试零成本清理，够用就停；不够再调 LLM；极端时才动用有损压缩。

##### 架构图

```
            ┌─────────────────────────────────────────────────────┐
            │  触发检测器（每次 model.next() 前计算 token 占用率）  │
            └──────────────────┬──────────────────────────────────┘
                               │
         ┌─────────────────────┼──────────────────────┐
         │                     │                      │
       < 60%              60% ~ 87%                 > 87%
         │                     │                      │
         ▼                     ▼                      ▼
      直接通过            Tier 1 清理            Tier 2 摘要
      (什么都不做)        (零成本本地)           (调摘要 LLM)
                               │                      │
                               │                      │  失败 3 次
                               │                      ▼
                               │                熔断 → 回退到
                               │                Tier 1 + 用户提示
                               │
                            > 95%
                               │
                               ▼
                      Tier 3 极端（可选，第一版不做）
```

##### Tier 1：本地零成本清理

- **触发**：占用率 ≥ 60%
- **成本**：0（纯本地代码，不调任何 LLM）
- **清理规则**（第一版实现 3 条）：
  1. **同文件去重**：对同一个文件的多次 `read_file`，只保留最新一次的 `tool_result`（旧的被新的覆盖了）
  2. **删失败重试**：连续失败的同一工具调用，只保留最后一次错误（重复错误无信息量）
  3. **折叠冗余工具输出**：如果两次 `list_files` / `grep_files` 参数和输出都相同，只保留一条
- **保持不变式**：删除时必须保持 `tool_call ↔ tool_result` 配对完整（删结果时连带删对应调用）
- **预期节省**：20~30% token
- **为什么先试这一层**：**不花钱、不拖延、不损失语义**——纯粹扔掉机械冗余。没理由跳过

##### Tier 2：LLM 摘要 + 近窗保留 + 安全名单

- **触发**：占用率 ≥ 87%（Tier 1 做过但仍不够）
- **成本**：一次快速模型调用（Haiku / Flash），几千 token input + 几百 token output
- **机制**：
  1. **切分点**：保留最近 M 条消息作为"近窗"原文（`M ≈ 20% × context_window`）
  2. **配对保护**：切分点若落在 `assistant_tool_call` / `tool_result` 中间，整对推入旧区或整对拉入近窗——不能拆
  3. **安全名单**：旧区里的 `ask_user` 结果和非幂等 `run_command` 永远保留原文，不进摘要
  4. **摘要调用**：被摘要部分交给摘要 LLM，生成 `context_summary` 文本
  5. **组装**：`messages = [system, context_summary, ...safety_list, ...recent_window]`
- **熔断机制**：摘要调用连续失败 3 次 → 熔断 Tier 2，回退到 Tier 1 + 提示用户"自动摘要失败，请手动 /compact"
- **为什么 87% 而不是 70%**：留给 Tier 1 足够空间尝试。只有 Tier 1 也救不了时才为语义理解付费
- **关于 Tier 2 内部的决策细节**：前面的"3 维决策框架"、"工具分类表"、"经济学公式 P × R"、"P 的不可知性"讨论，**全部仍然有效**——它们都是用来理解 Tier 2 内部为什么这么设计的

##### Tier 3-Lite：简化版极端压缩（第一版实现）

- **触发**：
  - 自动：Tier 1 + Tier 2 之后仍 > 95%（实际极少发生）
  - 手动：用户敲 `/compact --deep`
- **Claude Code 的完整版 vs MiniCode 的简化版**：

| 想法 | Claude Code 完整版 | MiniCode Tier 3-Lite |
|---|---|---|
| 结构化摘要 | **九节**（task / files / decisions / tool_calls / errors / preferences / progress / unfinished / constraints） | **三节**（task / files_touched / decisions） |
| 激进剥离 | 剥离 chain-of-thought + 中间推理 | 删除所有 `assistant_progress` 消息 |
| 近窗缩小 | 更激进 | 从 20% → 10% |

- **具体算法**：
  1. **零成本剥离 CoT**：`messages.filter(m => m.role !== 'assistant_progress')` —— 一行代码删光所有"内心独白"
  2. **三节结构化摘要**：把旧区消息交给摘要 LLM，但用严格的 system prompt 约束输出格式：
     ```
     Extract into exactly 3 sections:
     (1) task: 当前正在做的任务是什么（一句话）
     (2) files_touched: 动过哪些文件（数组）
     (3) decisions: 做过的关键决定（数组）
     Output ONLY valid JSON, no other text.
     ```
  3. **解析 + 序列化**：LLM 返回 JSON → 解析 → 序列化成一段结构化的 `context_summary` 文本
  4. **近窗缩小**：从 Tier 2 的 20% 压到 **10%**（因为 Tier 3 触发本身就意味着空间极紧张）
  5. **组装**：`messages = [system, structured_summary, ...safety_list, ...近窗(10%)]`

- **为什么 Tier 3-Lite 和 Tier 2 本质不同**：

| 维度 | Tier 2 | **Tier 3-Lite** |
|---|---|---|
| 摘要结构 | 自由文本 | **3 段结构化 JSON** |
| `assistant_progress` 消息 | 保留 | **全删** |
| 近窗大小 | 20% | **10%** |
| 摘要 prompt | 开放式 | **强结构约束** |
| 触发占用率 | 87% | **95% 或手动** |
| 压缩率 | ~60% → 30% | ~90% → 40% |

Tier 2 让 LLM 自由判断保留什么；Tier 3-Lite **用结构化约束换极端压缩率**——这是两种本质不同的策略。

- **关于 Chain-of-Thought (CoT)**：MiniCode 的 `assistant_progress` role 就是这个系统里的 CoT——AI 在工具调用之间的"内心独白"，相当于最终答案的"脚手架"。CoT 对**当时**的 agent 重要（指导下一步），但对**未来**的 agent 几乎无用（工具结果已经在 `tool_result` 里，最终结论已经在后面的 `assistant` 里）。Tier 3 删除 `assistant_progress` = 接受小的语义损失换大的空间——只在 95% 极端情况才这么做。

- **为什么是 3 节而不是 9 节**：
  1. 9 节的 prompt 设计非常精细，小模型（Haiku）可能做不好
  2. 3 节抓核心（正在做什么 / 动过哪些文件 / 有哪些决定），覆盖绝大多数用户会问的问题
  3. 第一版够用；未来真的发现 3 节不够再扩展

- **面试价值**：Tier 3-Lite 的实现证明你**真的理解了 Claude Code 的三层架构**——不是知道它，而是亲手做了简化版。面试话术：「我实现了 Tier 3 的简化版——用 3 节结构化摘要代替完整版的 9 节，用 `assistant_progress` 过滤代替完整的 CoT 剥离。核心思想完全一致：**用结构化约束换极端压缩率**。」

##### 实施细节与边界情况

**占用率的计算**

```
占用率 = 当前 messages 的 token 总数 / 当前模型的 context window 大小
```

**Token 数怎么算？两种方案**：

| 方案 | 精度 | 代价 | 选择 |
|---|---|---|---|
| A. 调 Anthropic `/v1/messages/count_tokens` | 精确 | HTTP 延迟 + 可能付费 | ❌ 第一版不用 |
| B. 字符数估算：英文 `chars/4`、中文 `chars/2`、混合 `chars/3` | ±10% | 0 | ✅ **选用** |

**实施要点**：
- 占用率的分子**只算增长部分**（user / assistant / assistant_progress / tool_call / tool_result），不算 system prompt（system 固定不变，算它没意义）
- 每次 `model.next()` 调用**之前**计算一次
- 误差 ±10% 对触发阈值完全够用——因为阈值本身也是经验值

**摘要模型的硬约束**

> **摘要模型的 context window 必须 ≥ 主模型的 context window。**

这是一条硬规则，违反就会出现鸡生蛋问题——要摘要的内容塞不进摘要模型。

**默认选择**：

| 主模型 | 默认摘要模型 | 理由 |
|---|---|---|
| Claude Sonnet/Opus (200k) | **Claude Haiku (200k)** | 同家族、同 context、便宜 |
| Gemini 2.5 Pro (1M) | **Gemini 2.5 Flash (1M)** | 同家族、同 context、便宜 |
| GPT-5 / GPT-4o | **GPT-5-mini / GPT-4o-mini** | 同家族、同 context、便宜 |
| 主模型找不到小型同家族 | **回退：用主模型自己** | 贵但保证 context 够用 |

**规则实施**：放在 `src/config.ts` 里做一个映射表。用户也可以在配置里手动覆盖。

**阈值常量的来源与可配置性**

60% 和 87% 这两个数字**不是数学推导出来的最优值**——是 Claude Code 源码泄露后社区整理的真实常量。Anthropic 工程师有数百万真实会话数据去调优，MiniCode 没有，所以**直接抄**。

**可配置**：所有阈值都从 `config.ts` 读取，允许环境变量覆盖：

```
MINI_CODE_COMPACT_TIER1_THRESHOLD=0.60
MINI_CODE_COMPACT_TIER2_THRESHOLD=0.87
MINI_CODE_COMPACT_TIER3_THRESHOLD=0.95
MINI_CODE_COMPACT_RECENT_WINDOW_RATIO=0.20
MINI_CODE_COMPACT_RECENT_WINDOW_RATIO_TIER3=0.10
MINI_CODE_COMPACT_CIRCUIT_BREAKER_FAILURES=3
```

这样未来你真的用 MiniCode 用多了，发现"我的场景下 60% 太早了"，直接改环境变量就行，不用改代码。

##### 触发阈值表

| 占用率 | 动作 | 用户感知 |
|---|---|---|
| 0 ~ 59% | 无 | 无感 |
| 60 ~ 86% | **Tier 1 自动启动** | 无感（零成本本地清理） |
| 87 ~ 94% | **Tier 2 自动启动** + 状态栏提示 "Compacting..." | 轻微停顿（几秒） |
| ≥ 95% | **强提示**"上下文接近极限，建议立即 /compact 或开启新会话" | 警告 |
| 任意时刻 | 手动 `/compact` | 用户主动触发 Tier 2 |

##### 为什么这样设计是"温柔渐进"

三层 + 双阈值实现**分级温柔**：

1. 60% 以下完全不动 → 用户无感
2. 60~87% 偷偷清理冗余 → 用户无感
3. 87~95% 调 LLM 摘要 → 有感但不打断
4. 95%+ 强提示 → 用户做决定

对比 "到达 70% 直接调 LLM 摘要" 的粗暴策略，三层方案：
- **更省钱**：大部分会话停在 Tier 1 就够了
- **更顺滑**：用户无感的占比更高
- **更稳定**：有熔断，不会因为摘要 LLM 挂了就崩

##### 与之前的 C 方案是什么关系

**之前讨论的 C 方案（摘要 + 近窗 + 安全名单）其实就是 Tier 2 的具体实现方式**。三层架构没有推翻 C，而是把 C 作为中间一层，前面加了 Tier 1，后面加了 Tier 3。

| 之前的 C 方案 | 现在的三层架构 |
|---|---|
| 摘要 + 近窗 + 安全名单 | = Tier 2 |
| 配对保护 | 每层都满足，仍是铁律 #1 |
| LLM 做摘要 | = Tier 2 的 LLM 调用 |
| （无） | + Tier 1（本地清理） |
| （无） | + Tier 3-Lite（简化版极端兜底，第一版实现） |
| （无） | + 熔断机制 |
| （无） | + 双阈值触发 |

##### 第一版实现范围（显式声明）

**做**：
- ✅ Tier 1 本地清理（3 条规则：同文件去重、删失败重试、折叠冗余）
- ✅ Tier 2 LLM 摘要 + 近窗 + 安全名单
- ✅ **Tier 3-Lite**：三节结构化摘要 + 删除 `assistant_progress` + 10% 近窗
- ✅ 双阈值触发（60% / 87%）+ 95% 触发 Tier 3-Lite
- ✅ 熔断机制（连续失败 3 次）
- ✅ 手动 `/compact` 命令 + `/compact --deep` 触发 Tier 3-Lite
- ✅ 95% 强提示
- ✅ 占用率字符数估算（误差 ±10%）
- ✅ 摘要模型的 context window 约束（≥ 主模型）
- ✅ 所有阈值可通过环境变量覆盖

**不做**（显式声明，避免 scope creep）：
- ❌ Claude Code 完整的 9 节摘要（我们用 3 节版本代替）
- ❌ 调 `/v1/messages/count_tokens` 精确 token 计数（用字符估算够了）
- ❌ 与 Anthropic prompt caching 的 `cache_edits` 前缀保护（等真正启用 prompt caching 时再做）
- ❌ Session restore / 长会话持久化（独立 feature，spec 另开）
- ❌ 递归摘要 / 流式摘要（第一版的简单切分就够了）

##### 为什么这个架构值得直接抄

1. **这是真实答案**：Claude Code 源码泄露后，业界看到他们的上下文管理用的就是三层架构。抄这个等于抄 production 系统
2. **面试深度拉满**：「我实现了 Claude Code 的三层上下文管理」 ≫ 「我发明了一套压缩方案」
3. **增量实施友好**：三层可以一层一层做。第一版只做 Tier 1 + Tier 2 就已经比 90% 的 agent 项目强
4. **(d) 方案的精华没浪费**：方案 (d) 纯工具类型分类的智慧融入了 Tier 2 的"安全名单"——对少数协议级别绝对保护的工具（`ask_user`、非幂等命令）用硬规则兜底，其余交给 LLM

#### 面试金句（本节沉淀）

- 「上下文压缩不是压缩算法问题，是记忆管理问题。好的压缩策略反映你对 agent 未来会做什么的预测。」
- 「扩大 context window 没解决问题，只是把崩溃变成了又贵又笨。」
- 「Lost in the middle 不是 attention 的 bug，是训练数据的先验：模型学到了首尾重要、中间填充。」
- 「如果允许孤儿 tool_result，LLM 会幻觉出不存在的工具调用上下文——这对 agent 是灾难，因为每一步都依赖前一步的真实结果。」
- 「上下文压缩的核心难题是预测每条信息的未来重要性。因为无法精确预测，所有策略都是对这个概率的启发式估计。滑动窗口赌'近期更重要'，纯摘要赌'细节都不重要'，Claude Code 则把预测问题外包给 LLM 本身——让模型自己判断该保留什么。」
- 「我用的是 Claude Code 的三层架构（Tier 1 本地去重 → Tier 2 LLM 摘要 → Tier 3 极端兜底）。核心哲学是：不同强度的压缩对应不同成本，先便宜后贵。大部分会话停在 Tier 1 就够了，根本不用花钱调摘要 LLM。」
- 「为什么双阈值？单阈值会强制所有会话都付 LLM 摘要的钱，即使大部分会话靠本地去重就能解决。60% 触发 Tier 1 让'便宜路径'尽可能长，87% 触发 Tier 2 只在必要时才付语义费。」
- 「熔断机制是 production 和 demo 的分界线。摘要 LLM 会失败——超时、空响应、API 错误。连续 3 次失败就熔断 Tier 2 回退到 Tier 1 + 用户提示，这是最低限度的故障处理。没有熔断的 agent 是玩具。」
- 「Tier 2 内部用'LLM 摘要 + 近窗保留 + 安全名单'，用 LLM 语义理解处理 99% 的压缩判断，用硬规则兜底协议级不变量（ask_user 的 tool_result 绝对保留、非幂等命令绝对保留）。这是动态判断 + 静态兜底的组合。」
- 「Tier 3-Lite 的核心是**用结构化约束换极端压缩率**。我让摘要 LLM 按严格的 3 节 JSON schema（task/files_touched/decisions）输出，同时删除所有 assistant_progress 消息——这些是 CoT 脚手架，对未来的 agent 几乎无用。这是对 Claude Code 九节版本的简化，但保留核心思想。」
- 「Chain-of-Thought 的本质是用 token 数换算力——让模型消耗 token 去生成推理，每个推理 token 都是一次额外的前向传播。在 MiniCode 里 CoT 就是 `assistant_progress` 消息，是'内心独白'。Tier 3 删除它是因为：CoT 对当时的 agent 重要（指导下一步），但对未来的 agent 无用（工具结果和最终结论已经在别处）。」
- 「阈值 60% / 87% / 95% 不是数学推导的最优值，是 Claude Code 源码泄露后看到的经验常量。Anthropic 有数百万真实会话数据去调优，我没有，所以直接抄并让它们可配置——未来有自己的数据再校准。」
- 「摘要模型的 context window 必须 ≥ 主模型。否则会出现鸡生蛋问题：要摘要的内容塞不进摘要模型自己。默认用同家族的小模型（Haiku/Flash/mini），找不到就回退到主模型自己做摘要。」

#### Tier 1 清理规则具体算法

Tier 1 原本计划 3 条规则，讨论后**合并成 2 条统一规则**（最终形态）。

##### 规则合并：从 3 条到 2 条

**原本的 3 条**：
1. 同文件去重（`read_file`）
2. 删失败重试
3. 折叠冗余工具输出（`list_files` / `grep_files`）

**观察**：规则 1 和规则 3 其实是同一个模板——**幂等只读工具按 `(toolName, 规范化参数)` 分组，只留最新**。只是白名单工具不同。

**合并后**：

| 合并后 | 做什么 |
|---|---|
| **规则 A：幂等只读工具去重** | `read_file / list_files / grep_files / ...` 按 `(tool, args)` 分组，只留最新 |
| **规则 B：删连续相同失败** | 连续的 + 同工具 + 同参数 + 同错误的失败 → 只留最后一个 |

**为什么合并是正确的**：两条规则本来就用同一套数据结构（Map 分组 + 索引比较），只是工具白名单不同。合并后：
- 代码行数少一半
- 加新幂等工具只需改白名单配置，不需要写新规则
- 消除了"read_file 规则" vs "list_files 规则"的人为区分

##### 前置条件（隐藏 invariant）

Tier 1 所有规则依赖一个**隐藏前提**：

> **`messages` 数组必须按时间顺序排列（索引越大 = 时间越晚 = 越新）。**

MiniCode 的 `agent-loop.ts` 只 `append` 不重排，这个前提天然成立。但任何依赖数组顺序的算法都应该在 spec 里**显式写下来**——否则将来有人改了上游行为，算法会安静地失效。

**面试金句**：
> 「依赖数组顺序的算法必须显式声明这个前提。'隐藏 invariant' 是 legacy code 坏掉的最常见原因——代码看起来工作正常，直到有人改了上游的某个细节，然后一切都坏了但错误信息指向了另一个地方。」

##### 规则 A：幂等只读工具去重

**白名单**（在 `context-compactor.ts` 顶部配置）：

```typescript
const IDEMPOTENT_READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep_files',
  'glob_files',
  'count_lines',
  // 新工具：在这里加一行就行
])
```

**算法**（O(N) 线性扫描）：

```typescript
function dedupeIdempotentReads(
  messages: ChatMessage[],
): ChatMessage[] {
  // 1. 扫一遍，为每个 (tool, args) 组记录最大索引
  const lastIndexByKey = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (
      msg.role === 'assistant_tool_call' &&
      IDEMPOTENT_READ_ONLY_TOOLS.has(msg.toolName)
    ) {
      const key = groupKey(msg)
      lastIndexByKey.set(key, i)   // 覆盖式写入，最后一次写入留下的就是最大索引
    }
  }

  // 2. 收集所有"非最新"的 tool_call 索引及其配对 tool_result
  const toDelete = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (
      msg.role === 'assistant_tool_call' &&
      IDEMPOTENT_READ_ONLY_TOOLS.has(msg.toolName)
    ) {
      const key = groupKey(msg)
      if (lastIndexByKey.get(key) !== i) {
        toDelete.add(i)
        const trIdx = findMatchingToolResult(messages, i, msg.toolUseId)
        if (trIdx !== -1) toDelete.add(trIdx)
      }
    }
  }

  return messages.filter((_, i) => !toDelete.has(i))
}

function groupKey(msg: AssistantToolCall): string {
  // 关键：规范化 input
  //   - path 字段必须 path.resolve(cwd, p)
  //   - 其他字段 JSON.stringify 作为签名
  const normalized = normalizeInput(msg.toolName, msg.input)
  return `${msg.toolName}:${JSON.stringify(normalized)}`
}
```

**关键实施点**：
1. **规范化路径必须用调用时的 cwd**（记录在 `tool_result` 生成时），不能用事后的 cwd——否则历史 `cd` 过的对话会算错
2. **`Map.set()` 天然覆盖**：扫描时每次遇到同 key 就覆盖，循环结束后留下的就是最大索引。不需要排序，不需要比较
3. **配对保护**：删 `tc` 的同时必须删对应的 `tr`，遵守铁律 #1

**为什么不用内容 hash 作为分组 key**：
- hash 会把"文件被修改"误判成"这是两个不同的文件"→ 不去重
- 我们的语义是「同一个文件的多次读，留最新」——**文件被修改恰恰是我们要检测的信号**（新版本应该覆盖旧版本）
- 分组单位是**文件的身份**（路径），不是**内容的身份**（hash）

##### 规则 B：删连续相同失败

**触发条件**（五个必须同时成立）：

```
删 [tc_j, tr_j] 当且仅当：
  1. tr_j.isError === true
  2. 存在紧邻的前一对 [tc_{j-2}, tr_{j-2}]，且：
     a. 中间没有其他 tc/tr 配对（"紧邻"）
     b. tc_{j-2}.toolName === tc_j.toolName
     c. JSON.stringify(tc_{j-2}.input) === JSON.stringify(tc_j.input)
     d. tr_{j-2}.isError === true
     e. tr_{j-2}.content === tr_j.content
```

**"紧邻"的重要性**：意味着 agent 在**连续重试同一个操作**。如果中间隔了其他操作（比如 agent 试了 A → 试了 B → 再试 A），后面那次可能是"环境变了再试一次"，保留原文是有价值的——所以只删真正相邻的重复。

**伪代码**：

```typescript
function deleteConsecutiveDuplicateFailures(
  messages: ChatMessage[],
): ChatMessage[] {
  const toDelete = new Set<number>()

  // 找所有 [tc, tr] 配对的索引
  const pairs: Array<{ tcIdx: number; trIdx: number }> = []
  for (let i = 0; i < messages.length - 1; i++) {
    if (
      messages[i].role === 'assistant_tool_call' &&
      messages[i + 1].role === 'tool_result'
    ) {
      pairs.push({ tcIdx: i, trIdx: i + 1 })
    }
  }

  // 扫相邻的两对
  for (let p = 1; p < pairs.length; p++) {
    const prev = pairs[p - 1]
    const curr = pairs[p]

    // 必须真的紧邻（中间无其他 tc/tr）
    if (curr.tcIdx !== prev.trIdx + 1) continue

    const prevTc = messages[prev.tcIdx] as AssistantToolCall
    const prevTr = messages[prev.trIdx] as ToolResult
    const currTc = messages[curr.tcIdx] as AssistantToolCall
    const currTr = messages[curr.trIdx] as ToolResult

    if (
      prevTr.isError &&
      currTr.isError &&
      prevTc.toolName === currTc.toolName &&
      JSON.stringify(prevTc.input) === JSON.stringify(currTc.input) &&
      prevTr.content === currTr.content
    ) {
      toDelete.add(curr.tcIdx)
      toDelete.add(curr.trIdx)
    }
  }

  return messages.filter((_, i) => !toDelete.has(i))
}
```

##### 为什么规则 B 故意保守

一个常见的更激进方案：「既然后面有成功调用，就把前面所有失败都删掉」。**这是错的**：

1. **信息丢失**：失败路径是推理链的证据。用户问"你为什么改用这个参数"时，agent 需要失败历史才能回答
2. **定义模糊**：需要定义"什么叫'后面有相似的成功'"——模糊匹配 + O(N²)
3. **越界**：语义级的判断（"这些失败是同一次 debug 过程，可以总结"）应该交给 **Tier 2 的 LLM**，不是 Tier 1 的硬规则

**Tier 1 的职责**是「零语义风险的机械去重」——只删"任何人一眼就看出来是重复"的消息。剩下的语义级压缩留给 Tier 2。这是**零成本机械层 vs 有成本语义层**的分工。

##### 两条规则的执行顺序

```
messages
  ↓
规则 A：幂等只读去重
  ↓
规则 B：连续失败去重
  ↓
（可选）再跑一次 assertWellFormed 校验（防御式）
  ↓
Tier 1 清理后的 messages
```

**为什么 A 先 B 后**：规则 A 可能会删掉一些 `read_file` 配对。如果某个连续失败恰好夹在被删的 `read_file` 配对之间，规则 B 的"紧邻"判断需要基于**删完 A 之后的序列**。先 A 后 B 保证"紧邻"是相对于最终序列的。

##### 面试金句

- 「Tier 1 的 3 条原始规则被合并成 2 条——发现'read_file 去重'和'list_files 去重'是同一个模板的两个实例，用统一的"幂等只读工具白名单 + (tool, args) 分组 + 保留最新"解决，代码行数少一半。这是**重复的早期识别 + 抽象**——发现两个'看起来不同'的需求其实是同一个模式，立刻合并。」
- 「Tier 1 故意保守——只删'任何人一眼就看出来是重复'的消息。语义级判断（比如'这段失败路径是 debug 循环，可以总结'）留给 Tier 2 的 LLM。这是**零成本机械层 vs 有成本语义层**的明确分工。」
- 「`messages` 数组的时间顺序是 Tier 1 所有规则的隐藏 invariant。任何依赖数组顺序的算法都应该显式声明这个前提——'隐藏 invariant' 是 legacy code 坏掉的最常见原因。」

#### 配对保护算法（Pair Guard）

Tier 2 / Tier 3-Lite 按 token 预算切分 `messages`，**切点位置是被 token 数学强算出来的**，不是我们主动挑的。这个被强算出来的 `desiredIdx` 经常会落在 `assistant_tool_call` / `tool_result` 配对中间——因为每条消息的 token 数很不均匀（一条 `tool_result` 可能几千 token，一条 `user` 只有 5 token）。

如果直接在 `desiredIdx` 切，就会违反铁律 #1（配对约束），两边都会出现孤儿消息，API 立刻拒收。

**算法的职责**：给定一个被 token 预算算出来的粗糙 `desiredIdx`，**调整**它到最近的合法位置（`safeIdx`），保证两边配对完整。

##### 核心规则

```
if role === 'assistant_tool_call'  →  pending.add(toolUseId)     ← 开一个"未完成配对"
if role === 'tool_result'          →  pending.delete(toolUseId)  ← 关闭对应的配对
其他 role（system/user/assistant/...）                            ← 不动 pending
```

**`pending.size === 0` 的位置 = 安全切点**，意思是"此前所有 `tool_call` 都已经配齐 `tool_result`，没有孤儿"。

##### 停车场类比

- `assistant_tool_call` = 一辆车**开进停车场**（+1）
- `tool_result` = 对应那辆车**开出停车场**（-1）
- `system / user / assistant / assistant_progress` = **路人**走过（不动）
- **停车场里车数为 0 的时刻 = 安全切点**

##### 方向选择：永远往前走

```
往前走（safeIdx < desiredIdx） → 摘要区变大，近窗变小 → ✅ 不会超预算
往后走（safeIdx > desiredIdx） → 摘要区变小，近窗变大 → ❌ 可能爆预算
```

**规则**：**总是往前找最近的安全切点**（`safeIdx ≤ desiredIdx`）。这保证 token 预算是一个上界，不会被配对约束破坏。

##### 伪代码（O(N) 线性扫描）

```typescript
function findSafeCutPoint(
  messages: ChatMessage[],
  desiredIdx: number,
): number {
  const pending = new Set<string>()  // 未配对的 tool_use id
  let lastSafe = 0                   // 最后一个已知的安全切点

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'assistant_tool_call') {
      pending.add(msg.toolUseId)
    } else if (msg.role === 'tool_result') {
      pending.delete(msg.toolUseId)
    }

    // 当 pending 为空时，i+1 是一个安全切点
    if (pending.size === 0) {
      if (i + 1 <= desiredIdx) {
        lastSafe = i + 1
      } else {
        break  // 已超过期望位置，不用继续扫
      }
    }
  }

  return lastSafe
}
```

##### 走通三个例子

**例 1：切点正好在配对之后**

```
索引:  0    1    2    3    4    5
角色:  sys  usr  tc1  tr1  usr  asst
期望:  desiredIdx = 4
```

| i | role | 动作 | pending | 为空？ | safe |
|---|---|---|---|---|---|
| 0 | sys | 不动 | `{}` | ✅ | 1 |
| 1 | usr | 不动 | `{}` | ✅ | 2 |
| 2 | tc1 | +1 | `{1}` | ❌ | - |
| 3 | tr1 | -1 | `{}` | ✅ | 4 |
| 4 | usr | 不动 | `{}` | ✅ | 5 > 4, 停 |

**返回 4**。完美命中。

**例 2：切点落在配对中间**

```
索引:  0    1    2    3    4    5
角色:  sys  usr  tc1  tr1  usr  asst
期望:  desiredIdx = 3（落在 tc1 和 tr1 中间）
```

| i | role | 动作 | pending | 为空？ | safe |
|---|---|---|---|---|---|
| 0 | sys | 不动 | `{}` | ✅ | 1 |
| 1 | usr | 不动 | `{}` | ✅ | 2 |
| 2 | tc1 | +1 | `{1}` | ❌ | - |
| 3 | tr1 | -1 | `{}` | ✅ | 4 > 3, 停 |

**返回 2**。算法主动退回到配对之前的最后一个安全点，整对 `[tc1, tr1]` 进近窗。

**例 3：长工具链横跨期望位置**

```
索引:  0    1    2    3    4    5    6    7
角色:  sys  usr  tc1  tc2  tr1  tr2  usr  asst
期望:  desiredIdx = 4
```

| i | role | 动作 | pending | 为空？ | safe |
|---|---|---|---|---|---|
| 0 | sys | 不动 | `{}` | ✅ | 1 |
| 1 | usr | 不动 | `{}` | ✅ | 2 |
| 2 | tc1 | +1 | `{1}` | ❌ | - |
| 3 | tc2 | +1 | `{1,2}` | ❌ | - |
| 4 | tr1 | -1 | `{2}` | ❌ | - |
| 5 | tr2 | -1 | `{}` | ✅ | 6 > 4, 停 |

**返回 2**。整个工具链 `[tc1, tc2, tr1, tr2]` 是一个**不可分的"原子团"**——算法把它整组推进近窗。近窗略微超过预算，但这是配对约束的必要代价。

##### 边界情况

**如果 `desiredIdx` 之前完全没有安全点？**

极端例子：从第 1 条就是一个超长工具链，没有"休息点"。算法返回 `lastSafe = 0` → **整段对话都进摘要区，近窗为空**。

这是退化情况，但算法正确处理：**宁可整段摘要，也不出孤儿消息**。

##### 🔒 前置条件：输入必须是良构的

**算法只能保护已有的配对，不能凭空制造不存在的配对。**

如果传入的 `messages` 本身就有孤儿（比如有一个 `tool_call` 但没有对应的 `tool_result`），算法也会返回一个 safe 值，但**孤儿仍然会保留在输出里**——因为算法没有能力发明一个不存在的 `tool_result`。

**所以**：压缩器有一条前置条件（**precondition**）：

> **`context-compactor.ts` 的输入必须是良构的 `messages`——所有 `tool_call` 都有对应的 `tool_result`。如果这个前提被破坏，问题应该在上游（`agent-loop.ts`）解决，不是压缩器的职责。**

##### Defensive Mode：入口校验

MiniCode 采用 **defensive mode**——压缩器入口显式校验良构性，发现孤儿立刻抛异常：

```typescript
function assertWellFormed(messages: ChatMessage[]): void {
  const pending = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant_tool_call') {
      pending.add(msg.toolUseId)
    } else if (msg.role === 'tool_result') {
      if (!pending.has(msg.toolUseId)) {
        throw new CompactorError(
          `orphan tool_result: toolUseId=${msg.toolUseId}`,
        )
      }
      pending.delete(msg.toolUseId)
    }
  }
  if (pending.size > 0) {
    throw new CompactorError(
      `orphan tool_call(s): ${[...pending].join(', ')}`,
    )
  }
}
```

**为什么 defensive mode 而不是 trust mode**：
1. **早失败比晚失败好**：压缩器抛 `CompactorError: orphan tool_call detected` 比主模型返回晦涩的 HTTP 400 更容易调试
2. **失败位置清晰**：立刻能定位到是上游哪里产生了孤儿
3. **代价极小**：10 行校验代码，O(N) 时间

##### 职责划分

| 谁的责任 | 做什么 |
|---|---|
| **`agent-loop.ts`** | 保证每次 `assistant_tool_call` 后必定追加对应的 `tool_result`（哪怕工具失败也要 `isError: true` 的 result） |
| **错误恢复路径**（`awaitUser` / thinking 中断 / 空响应） | 异常中断时也要保证不留下孤儿 |
| **`context-compactor.ts`** | **假设输入良构**，只做压缩，不做修复。入口 assertWellFormed 抛异常而非默默修复 |

这是 **separation of concerns** 的典型应用：每个模块专注自己的职责，不越界。

##### 面试金句

- 「配对保护算法的核心是线性扫描找最近的安全切点：维护一个待配对 tool_use 集合，每次集合变空就记录一个安全点，取期望切点之前的最后一个安全点。时间复杂度 O(N)，空间 O(配对数)。」
- 「关键设计决定：永远往前走不往后走。因为往后走可能让近窗超预算，破坏整个压缩的目的。前向保证 token 预算是一个上界。」
- 「配对保护算法只能保护已有的配对，不能凭空制造不存在的配对。压缩器的前置条件是输入 messages 良构——所有 tool_call 都有对应的 tool_result。如果上游产生了孤儿，压缩器应该立刻抛异常而不是偷偷放过，因为修复数据不是压缩器的职责。这是 separation of concerns 的典型应用。」

#### 安全名单（非幂等命令识别）

Tier 2 摘要时有一条硬规则：**某些 `tool_result` 永远保留原文，不进摘要**。其中最复杂的一类是**非幂等的 `run_command`**——因为 `run_command` 的参数是 shell 字符串，需要识别"哪些 shell 命令是非幂等的"。

##### 核心原则：Fail Closed / Safe by Default

> **"哪些命令算危险？"这个问题没法回答——清单无限长。反过来"哪些命令肯定安全？"答案很少——就十几个。所以我们列出那十几个"绝对安全"的，其他所有命令一律当危险。**

**机场安检类比**：
- ❌ **黑名单**（禁带刀枪炸药…）→ 清单永远列不完，明天出新武器就漏
- ✅ **白名单**（只允许衣服书电脑…）→ 清单有限，未见过的默认拒绝

**错判代价不对称**：
- 安全 → 当危险（多留点 token）= **可以接受**
- 危险 → 当安全（删掉 `rm -rf` 的记录）= **不可接受**

宁可错留 100 条，不可错删 1 条危险的。

##### 安全命令白名单（~20 条）

```typescript
const SAFE_COMMAND_PREFIXES = new Set([
  // 文件读取（不改磁盘）
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat',
  'grep', 'egrep', 'fgrep', 'find', 'locate',

  // 系统查询（不改状态）
  'pwd', 'whoami', 'id', 'uname', 'hostname', 'date',
  'which', 'whereis', 'type', 'echo', 'printenv', 'env',

  // 其他纯读
  'cksum', 'md5sum', 'sha256sum', 'diff',
])
```

**故意不在白名单的常见命令**：

| 命令 | 原因 |
|---|---|
| `git` | 子命令太多（push/rm/checkout 有副作用），整体不白名单 |
| `npm` / `pip` | 安装 = 副作用 |
| `curl` / `wget` | 可能 POST，可能 `-o` 写文件 |
| `sed` | `-i` 原地改文件 |
| `awk` | `system()` 可执行任意命令 |
| `docker` / `kubectl` | 各种子命令改状态 |

**代价**：这些命令即使实际是"读"（比如 `git status`），也会被保留在近窗里不进摘要。**可接受**——假阳性（多留）比假阴性（误删）安全得多。

##### 判断逻辑（~15 行代码）

```typescript
function isSafeCommand(cmd: string): boolean {
  const trimmed = cmd.trim()

  // 1. 禁止任何 shell meta-character
  //    有管道/重定向/命令链 → 一律视为不安全
  if (/[|&;<>$`(){}]/.test(trimmed)) return false

  // 2. 取第一个 token 作为命令名
  const firstToken = trimmed.split(/\s+/)[0]

  // 3. 查白名单
  return SAFE_COMMAND_PREFIXES.has(firstToken)
}

function isNonIdempotentRunCommand(tc: AssistantToolCall): boolean {
  if (tc.toolName !== 'run_command') return false
  const cmd = (tc.input as { command?: string }).command ?? ''
  return !isSafeCommand(cmd)
}
```

**关键设计点**：

1. **Meta-character 检查在白名单之前**：任何包含 `| & ; < > $ \` ( ) { }` 的命令直接拒绝。这些符号意味着"多命令组合 / 管道 / 子 shell / 重定向"，无法简单解析 → 拒绝比错误分析安全
2. **只看第一个 token**：`ls -la src/` 的第一个 token 是 `ls`，参数不影响安全性
3. **白名单必须小而准**：宁可漏掉一些"其实安全"的命令（如 `git status`），也不能错判危险命令
4. **可配置**：白名单放在 config 里或通过环境变量覆盖，方便用户按自己的环境微调

##### 反例验证

```typescript
isSafeCommand('ls -la')                    // true  ✅ 白名单 + 无 meta char
isSafeCommand('cat /etc/hosts')            // true  ✅
isSafeCommand('grep "TODO" src/')          // true  ✅
isSafeCommand('echo hello')                // true  ✅

isSafeCommand('rm -rf /')                  // false ✅ 不在白名单
isSafeCommand('git push')                  // false ✅ 不在白名单
isSafeCommand('npm install')               // false ✅ 不在白名单

isSafeCommand('echo "rm -rf /" > file.txt') // false ✅ 有 '>' 被 meta 检查拦截
isSafeCommand('ls | grep foo')             // false ✅ 有 '|'
isSafeCommand('ls && rm foo')              // false ✅ 有 '&&'
isSafeCommand('ls $(cat cmd)')             // false ✅ 有 '$(' 和 '('
```

**注意反例 `echo "rm -rf /" > file.txt`**：虽然 `echo` 在白名单里，但重定向 `>` 让它变成了"写文件"操作——meta-character 检查在白名单之前拦截，正确识别为危险。

##### 面试金句

- 「安全分类用白名单而非黑名单，因为**安全命令是有限集合，危险命令是无限集合**。枚举有限集合可行，枚举无限集合不可行。这是 **fail closed / safe by default** 原则——不确定就当危险。」
- 「任何包含 shell meta-character 的命令（`|`、`&`、`;`、`>`、`$`、反引号等）直接当不安全——因为我们没法简单解析多命令组合，拒绝分析比错误分析安全。」
- 「MiniCode 的安全列表只有 ~20 条，小且准。代价是 `git status` 这种'其实安全'的命令也会被过度保留——但假阳性比假阴性安全得多。这是**错判代价不对称**下的典型工程权衡：宁可错留 100 条，不可错删 1 条危险的。」

#### 摘要 Prompt 设计

Tier 2 和 Tier 3-Lite 都需要一个摘要 LLM 调用，本节给出两个 prompt 的完整模板以及设计原则。

##### 设计原则（6 条，通用于所有摘要 prompt）

**1. Principles, not Enumeration（原则式，而非枚举式）**

不要列"保留这条、保留那条"——那样 prompt 会变得和对话一样长。要给 LLM 一套**信息分级原则**，让它自己判断。

> **Enumeration Trap**：新手最常见的错误是想把"该留什么"写清楚，结果越写越长。正确做法是给 LLM 类别（HIGH/MEDIUM/LOW），让它把具体消息对号入座。这让 prompt 复杂度从 O(N) 降到 O(1)。

**2. Role + Goal 先行**

prompt 第一句必须回答两个问题：**"你是谁？你的输出给谁看？"**

摘要 prompt 的答案是："你是压缩器，输出给**同一个 agent 的未来版本**看。"——这改变 LLM 的写作风格（不用对人类礼貌，可以简洁直接）。

**3. 负面约束（明确告诉"可以丢什么"）**

人类写摘要时会"什么都想留一点"，LLM 也一样。所以要**明确列出可以丢的东西**——比这更有效的是"这些不要在输出里出现"这种否定式指令。

**4. 情境暗示紧急程度**

越激进的压缩，越要在 prompt 开头**明说"这是紧急状态"**。比如 Tier 3-Lite 开头说「invoked only when >95%, last line of defense」——这让 LLM 内部的 prior 偏向更激进的档位。

**5. 结构化输出的三层防御**

当需要 JSON 输出时，**不能只靠 prompt**。需要三层防御：
- 第一层：prompt 严格约束（"ONLY JSON, no markdown, no preamble"）
- 第二层：代码 `try/catch JSON.parse`
- 第三层：解析失败时熔断回退（触发降级流程），不让整个会话崩

**6. 反幻觉明确写出**

压缩任务下 LLM 特别容易编造，因为"精炼"的压力会让它给出漂亮但不准确的总结。**必须明确写** "Do not invent. Prefer omission over speculation."

##### Tier 2 Prompt 模板

```
You are a context compressor for an AI coding agent. Your job is to
compress a conversation history into a concise summary that the SAME
agent will use to continue the SAME task. The summary replaces the
original messages in the agent's context window.

## Priority (keep these)

HIGH — must preserve:
- The user's original task and any refinements
- Unresolved errors or blockers
- User preferences or constraints explicitly stated
- Decisions made with their reasoning
- Files that were modified (paths only, not contents)
- Unfinished sub-tasks

MEDIUM — summarize compactly:
- Tools used and their purposes (e.g., "read config files",
  not the full file contents)
- Paths of files inspected
- High-level progress through the task

LOW — drop entirely:
- Full contents of files (agent can re-read if needed)
- Individual error messages that were later resolved
- Reasoning/thinking between tool calls
- Repeated tool outputs
- Intermediate status messages

## Constraints

- Target length: ~10% of the original input length
- Write in second person ("you did X") — this is a note to
  the continuing agent, not to a human
- Be specific about file paths and function names — these are
  the hooks the agent uses to resume
- Do NOT wrap in markdown code blocks
- Do NOT add commentary like "Here is the summary:"
- Output the summary text directly

## Input

The conversation history follows below this line:
---
{MESSAGES_SERIALIZED_AS_TEXT}
```

##### Tier 3-Lite Prompt 模板

```
You are an EXTREME context compressor for an AI coding agent.
You are invoked only when the conversation has become critically
long (>95% of the context window) and lightweight compression is
not enough. Your job is to extract the absolute minimum information
needed for the same agent to resume the same task.

Your output replaces the original conversation history. Assume
EVERY token matters — this is the last line of defense before
the agent hits a hard context limit.

## Output format (STRICT)

Return ONLY a valid JSON object matching EXACTLY this schema.
No markdown code fences. No explanations. No preamble. Just JSON.

{
  "task": "<one sentence describing what the agent is trying to accomplish>",
  "files_touched": ["<absolute or workspace-relative path>", ...],
  "decisions": ["<concise decision or constraint>", ...]
}

## What to put in each field

task:
- Exactly ONE sentence
- Present tense, second person ("You are refactoring X to support Y")
- Captures the ORIGINAL user goal plus any refinements
- Do NOT describe progress or status — only the goal
- Max 30 words

files_touched:
- File paths that have been READ or MODIFIED
- Deduplicate automatically
- Max 20 entries — if more, keep the most recently touched

decisions:
- Concrete commitments the agent or user has already made
- Each ≤ 20 words
- Max 10 entries — keep the most load-bearing ones
- Do NOT include speculative ideas that were rejected
- Do NOT include tool outputs or file contents

## Hard rules

- Output ONLY the JSON object. No commentary, no markdown.
- If a field has no content, use empty string "" or empty array []
  — never null, never omit the field.
- Every string must be valid JSON (escape quotes, no unescaped newlines).
- Do not invent information not present in the input.
- Prefer omission over speculation.

## Input

The conversation history (already with assistant_progress messages
removed) follows below:
---
{MESSAGES_SERIALIZED_AS_TEXT}
```

##### 输入/输出示例对比

**示例输入**（简化的会话，实际 ~7000 tokens）：

```
[0]  system:              "You are MiniCode..."
[1]  user:                "帮我加一个 /save 命令导出对话为 markdown"
[2]  assistant:           "我先看现有命令"
[3]  assistant_tool_call: read_file('src/cli-commands.ts')
[4]  tool_result:         (120 行代码)
[5]  assistant_progress:  "看看 /cost 的模式作为参考..."
[6]  assistant_tool_call: read_file('src/usage-tracker.ts')
[7]  tool_result:         (200 行代码)
[8]  assistant_tool_call: read_file('src/types.ts')
[9]  tool_result:         (80 行代码)
[10] assistant:           "我会新建 src/export.ts ..."
[11] assistant_tool_call: write_file('src/export.ts', ...)
[12] tool_result:         ok
[13] assistant_tool_call: edit_file('src/cli-commands.ts', ...)
[14] tool_result:         "Cannot find registerCommand" isError=true
[15] assistant_tool_call: edit_file('src/cli-commands.ts', ...)
[16] tool_result:         ok
[17] assistant:            "完成了"
[18] user:                 "现在把 tool calls 也作为代码块导出"
```

**Tier 2 的输出**（自由文本，~150 tokens，压缩到 ~2%）：

```
Previous conversation summary:

You are implementing a `/save` slash command in MiniCode that exports
the current chat history as markdown. You studied `src/cli-commands.ts`
and `src/usage-tracker.ts` as reference patterns (the latter for the
`/cost` command structure). You then created `src/export.ts` as a new
module for serialization logic, and registered the `/save` handler in
`src/cli-commands.ts`. The first edit to cli-commands.ts failed
(wrong function name for registration), but the corrected second
attempt succeeded. The `/save` command is now functional.

The user's next request, not yet started: extend the export so that
tool_call messages are rendered as fenced code blocks in the output
markdown.

Files touched: src/export.ts (new), src/cli-commands.ts (modified),
src/usage-tracker.ts (reference), src/types.ts (reference).
```

**Tier 3-Lite 的输出**（严格 JSON，~80 tokens，压缩到 ~1%）：

```json
{
  "task": "You are adding a /save command to MiniCode that exports chat history as markdown; currently extending it to render tool_call messages as fenced code blocks.",
  "files_touched": [
    "src/export.ts",
    "src/cli-commands.ts",
    "src/usage-tracker.ts",
    "src/types.ts"
  ],
  "decisions": [
    "Created src/export.ts as a new module for serialization logic",
    "Modeled /save after /cost command's registration pattern",
    "Export handler lives in cli-commands.ts alongside existing commands"
  ]
}
```

**注意 Tier 3-Lite 的 JSON 不直接塞进 messages**——它会被**渲染成可读文本块**再作为 user message 插入：

```
[
  { role: 'system', content: '...' },
  { role: 'user',   content: 'Previous conversation summary (structured):
                               Task: You are adding a /save command...
                               Files touched: src/export.ts, src/cli-commands.ts, ...
                               Decisions:
                                 - Created src/export.ts as a new module...
                                 - Modeled /save after /cost command...
                                 - Export handler lives in cli-commands.ts...' },
  { role: 'user',   content: '现在把 tool calls 也作为代码块导出' }  // 近窗
]
```

JSON 是**内部传输格式**（便于代码解析 + schema 验证），塞进 messages 时格式化成文本。

##### 两种输出的关键差异

| 维度 | Tier 2 输出 | Tier 3-Lite 输出 |
|---|---|---|
| 失败历史 | ✅ 保留（"first edit failed"） | ❌ 丢弃 |
| 叙事性描述 | ✅ 有（"you then created"） | ❌ 只有结果 |
| 近窗保留 | 20% of context | 10% of context |
| 格式 | 自由文本 | 严格 JSON |
| 压缩比 | ~2% | ~1% |
| 解析风险 | 低（纯文本） | 中（JSON 可能被污染） |

**一个有意设计**：Tier 3-Lite **故意丢弃失败历史**。代价是 agent 之后可能重复昨天的错误（再次写错函数名），但在 95% 紧急状态下这是合理权衡——**宁可重做一次，不能爆 context**。

##### 面试金句

- 「好的摘要 prompt 是 O(1) 的：无论对话多长，prompt 都这么长。避免 enumeration trap——不要枚举'保留这条、那条'，而是给 LLM 一套分级原则让它自己判断。这等价于把信息重要性估计外包给 LLM 本身。」
- 「结构化输出（JSON）的 prompt 必须三层防御：prompt 严格约束 + 代码 try/catch + 熔断回退。只靠 prompt 约束会被污染，必须有代码兜底。」
- 「Tier 3-Lite 的核心 prompt 设计 trick 是'情境暗示紧急程度'——开头明说 'invoked only when >95%, last line of defense'，让 LLM 内部的 prior 偏向更激进的压缩档位。相同的 prompt 体骨如果不说情境，LLM 会写得和 Tier 2 差不多长。」
- 「Tier 3-Lite 故意丢弃失败历史，接受'agent 可能重犯错误'的代价。这是压缩的基本哲学：不同紧急程度接受不同的信息损失水平，而不是一个压缩策略适配所有情况。」

#### 被压缩掉的原始消息怎么办（压缩视角下的审计 trail）

**问题的真正范围**：当 Tier 2/3 做完摘要后，被丢掉的旧消息，**在当前运行中的会话里**要不要保留一份副本？

**注意划清边界**：
- ✅ 这个问题问的是「压缩副作用的影响范围」——发生在**单次会话运行时**
- ❌ 这**不是**「会话关闭后怎么持久化 + 跨进程恢复」——那是另一个独立 feature，见 **§4.18 会话持久化**

**选定方案：内存保留一份副本**

在 `context-compactor.ts` 内部维护一个 `archivedMessages: ChatMessage[]` 数组：

```
每次 Tier 2 / Tier 3-Lite 执行时：
  1. 识别被摘要掉的消息（旧区）
  2. 把它们 append 到 archivedMessages
  3. 运行时的 messages 数组替换成压缩后版本
  4. archivedMessages 对 agent-loop 不可见（不会影响 LLM 调用）
```

**提供 `/restore --peek` 命令**：用户可以查看被压缩掉的原始消息，但**不会**把它们塞回 messages（纯只读审计）。

**关键约束**：
- `archivedMessages` **只在当前进程内存**——关闭进程就丢
- 不写磁盘——写磁盘是 §4.18 的职责
- 不影响 LLM 的 token 成本——只是内存里的一个 JavaScript 数组

**为什么够用**：

| 用户的真实需求 | 内存保留能满足吗？ |
|---|---|
| 当前会话中回头确认 LLM 没胡说 | ✅ 能（`/restore --peek`） |
| 关机后第二天接着聊 | ❌ 不能（那是 §4.18） |
| 审计 trail 用于 compliance | ❌ 不能（那是 §4.18） |

**面试话术（压缩视角）**：

> 「压缩时被丢掉的原始消息在内存里保留一份副本（`archivedMessages`）。这是会话内审计 trail——用户随时可以 `/restore --peek` 查看原文确认 LLM 没胡说。至于跨进程持久化，那是一个独立的会话持久化 feature（§4.18），不应该和压缩耦合。把两件事分开是**避免 scope creep 的典型工程权衡**。」

**面试金句（scope 界限）**：

- 「上下文压缩和会话持久化是两个独立 feature。压缩解决'怎么让当前会话变短'，持久化解决'怎么让关机后还能找回会话'。两者在时间维度上不同：压缩在运行时，持久化跨进程。混在一起会让任何一个都做不好。」

#### 待决定的问题

- [x] **压缩策略**：~~滑动窗口 / 全文摘要 / 摘要+近窗混合 / 向量检索~~ → **✅ 三层架构（Tier 1 本地清理 + Tier 2 LLM 摘要 + Tier 3-Lite 结构化简化版）**
- [x] **触发时机**：~~手动 / 自动阈值 / 混合~~ → **✅ 双阈值自动（60% Tier 1 / 87% Tier 2 / 95% Tier 3-Lite）+ 手动 `/compact` 和 `/compact --deep`**
- [x] **摘要模型选择**：~~Haiku / Flash / 主模型~~ → **✅ 默认同家族小模型（硬约束：context window ≥ 主模型），找不到回退主模型自己**
- [x] **`context_summary` role 的具体结构**：Tier 2 用纯文本，**Tier 3-Lite 用结构化 JSON**（task / files_touched / decisions 三节）
- [x] **占用率计算**：字符数估算（英文 `/4`、中文 `/2`、混合 `/3`），误差 ±10% 可接受
- [x] **阈值可配置性**：通过环境变量 `MINI_CODE_COMPACT_*` 覆盖默认值
- [x] **原始历史存储（压缩视角）**：~~不存 / 内存 / 文件 / 文件+`/restore`~~ → **✅ 内存保留 `archivedMessages[]` + `/restore --peek` 只读命令**。跨进程持久化转到 §4.18
- [x] **配对保护的具体算法**：~~往前回退还是往后推进~~ → **✅ O(N) 线性扫描 + 永远往前走（`findSafeCutPoint`）+ defensive mode 入口校验（`assertWellFormed`）**
- [x] **安全名单的完整定义**：~~正则 / 关键字 / LLM 判断~~ → **✅ Fail Closed / Safe by Default：~20 条安全命令白名单 + 任何 shell meta-character 直接判危险**。错判代价不对称——宁可错留 100 条，不可错删 1 条
- [x] **摘要 prompt 设计**：~~具体给摘要模型什么 system prompt？~~ → **✅ 两个完整模板已写入**。设计原则：Principles not Enumeration（O(1) 长度）+ Role/Goal 先行 + 负面约束 + 情境暗示紧急程度 + 结构化输出三层防御 + 反幻觉明说。Tier 2 自由文本约 10%，Tier 3-Lite JSON 约 1%
- [x] **Tier 1 清理规则的具体算法**：~~同文件去重 / 失败重试 / 折叠冗余~~ → **✅ 合并成 2 条规则：规则 A 幂等只读工具去重（规范化路径 + `Map.set()` 覆盖式选最新）+ 规则 B 删连续相同失败（5 条严格条件 + "紧邻"约束）**。隐藏 invariant：messages 必须按时间顺序

#### 故意不做（intentionally skipped）

对照 Claude Code Complete Guide Part 8 的学习目标清单，以下两项**在 MiniCode 项目中故意跳过**：

- ⛔ **cache_edits 缓存感知压缩**：这是 Anthropic prompt caching 的延伸优化。MiniCode 当前**没启用 prompt caching**，短期也不会（见"第一版不做"列表）。纯理论学习当前没有 application，等真正启用 prompt caching 时再补
- ⛔ **API 层 compaction（`compact-2026-01-12` 头）vs 交互层 `/compact`**：`compact-2026-01-12` 是 Anthropic **服务端**能力。MiniCode 是客户端，而且**整个项目的学习目的就是"自己实现三层 compact"**——用服务端能力会偏离项目目标。如果面试被问到，可以说"我知道有这个服务端 header，但 MiniCode 选择客户端实现路线以深化架构理解"

这两条写在这里是**防止将来回来问"为什么没做"**——显式的"不做"比"漏了"更清晰。

后续 Socratic 对话会逐个回答这些问题。

---

### 4.18 会话持久化（session-archive.ts — 未来规划）

**状态**：🚧 未来 feature，尚未进入 Socratic 完整对话阶段。本节收录从 Claude Code 源码分析中学到的参考架构，作为未来讨论的起点。

#### 一句话定位

> **把整个会话的消息历史、元数据、压缩快照持久化到磁盘，支持跨进程恢复和审计。**

#### 与 §4.17 上下文压缩的关系

这是两个**独立且互补**的 feature：

| 维度 | §4.17 上下文压缩 | §4.18 会话持久化 |
|---|---|---|
| **解决的问题** | 运行时怎么让 `messages` 变短 | 关机后怎么保存和恢复整个会话 |
| **时间维度** | 单次会话运行时 | 跨进程 / 跨会话 |
| **输出** | 压缩后的运行时 `messages` | 磁盘上的会话目录 |
| **是否影响 token 成本** | ✅ 影响（核心目的） | ❌ 不影响（纯 I/O） |

**两者的耦合点**：
- §4.17 产生 `archivedMessages`（压缩时被丢掉的原文），§4.18 可以**选择性消费**这个数据
- §4.18 的持久化**应该包含未压缩原文**（transcript）**和**压缩后快照（checkpoint）
- 但 §4.17 不依赖 §4.18——可以单独实现

#### Claude Code 的真实架构（参考）

2025 年 Claude Code 部分源码泄露后，社区整理出的持久化架构：

```
~/.claude/projects/
  └── <project-hash>/              ← 每个项目一个目录，hash 来自 cwd
      └── sessions/
          └── <session-id>/        ← 每个会话一个子目录（UUID）
              ├── transcript.jsonl    ← 消息流，append-only
              ├── checkpoints/
              │   ├── cp-0001.json       ← Tier 2/3 后的压缩快照
              │   ├── cp-0002.json
              │   └── ...
              └── meta.json           ← 会话元数据
```

**三个文件的职责**：

**1. `transcript.jsonl`**（消息流，append-only）

```
每一行是一个 TranscriptLine：
  - timestamp
  - role: user | assistant | tool | system
  - payload（消息内容）
```

**关键特性**：
- **Append-only**：永不修改历史，只追加新行
- **JSONL 而非 JSON**：坏一行不影响其他行（支持 truncate-repair）
- **一行一事件**：grep 友好

**2. `checkpoints/cp-XXXX.json`**（压缩快照）

```
每个 checkpoint 包含：
  - atMessageIndex    ← 在 transcript 的哪一行开始
  - summary           ← 摘要文本
  - artifactRefs      ← 对大载荷的引用（而不是内嵌）
```

**关键洞察**：Claude Code **不是"原文和摘要二选一"**，而是**两个都存**：
- `transcript.jsonl` 保留所有原始消息（审计用）
- `checkpoints/` 保留每次压缩后的版本（运行时加载用）
- 运行时用 checkpoint（省 token），审计时看 transcript（看原文）

**3. `meta.json`**（会话元数据）

```
  - sessionId
  - projectPath       ← 对应哪个项目
  - cwd               ← 启动时的工作目录
  - cliVersion        ← 用的 CLI 版本（未来做版本迁移）
  - timestamps
  - parentSessionId   ← 如果这个会话是从另一个 fork 出来的
```

#### `claude -c` 的 resume 机制

```
findLatestResumableSession()
  ↓
按 updatedAt 排序 → 选最新的
  ↓
isSessionHealthy() 健康检查：
  - meta.json 可读
  - transcript JSON 完整（坏了就 truncate-repair）
  - checkpoint 索引一致
  - 磁盘可写
  ↓
失败 → 降级而非阻塞
```

**`truncate-repair`**：即便 transcript 损坏（比如进程被 kill 在写入一半），也能**从损坏行往前截断恢复**，不让用户的历史全丢。这是 JSONL 相对 JSON 的决定性优势。

#### 并发锁

**`.lock` 文件 + 进程级 advisory lock**，防止两个 CLI 实例同时写同一个 transcript.jsonl。

#### 清理策略

**Claude Code 文档明确说：不自动清理**。

理由（推测）：
1. JSONL 文件很小（一个 50k token 的会话 ≈ 200 KB）
2. 自动清理有"误删"风险
3. 用户手动 `rm -rf` 更安全

#### 高级特性：`parentSessionId` 会话 fork

Claude Code 支持**会话 fork**——从任意历史会话岔一条新分支，类似 git branch。实现方式：在 `meta.json` 里记录 `parentSessionId`。

#### MiniCode 的简化方案（未来 Socratic 对话时细化）

**第一版做**：
- ✅ `~/.mini-code/projects/<project-hash>/sessions/<session-id>/` 目录结构
- ✅ `transcript.jsonl` append-only
- ✅ `meta.json`（简化版）
- ✅ `/restore --last` 和 `/restore <id>`（基础版，不带健康检查）
- ✅ 不自动清理（对齐 Claude Code）

**第一版不做（仅文档化）**：
- ❌ `checkpoints/` 目录（第一版只有 transcript 原文）
- ❌ Truncate-repair（崩了就让用户手动修）
- ❌ `parentSessionId` fork
- ❌ `.lock` 并发锁（单实例使用不会撞）

#### 待决定的问题（留给未来 Socratic 对话）

- [ ] **写入时机**：每条消息立刻 append，还是批量 flush？
- [ ] **project hash 算法**：SHA-256(cwd) 前 8 位？完整路径 base64？
- [ ] **session ID 生成**：UUID v4，还是时间戳 + 随机后缀？
- [ ] **meta.json 最小字段**：MVP 要存哪些字段？
- [ ] **`/restore` UX**：列表怎么显示？按时间倒序 / 按项目分组？
- [ ] **压缩快照（checkpoints）第一版要不要做**：不做的话，restore 后还要重新压缩
- [ ] **transcript 格式向前兼容**：未来字段变了怎么处理？
- [ ] **会话元数据索引**：要不要建一个 `~/.mini-code/sessions-index.json` 方便快速列出？

#### 面试金句

- 「会话持久化的核心设计是'双文件架构'：transcript.jsonl 保留原始消息作为审计 trail，checkpoints 存压缩快照作为运行时加载入口。两者互不覆盖——原文永远在，压缩是一个视图。」
- 「选 JSONL 而不是 JSON 是因为 append-only 和损坏可恢复：JSONL 每行独立解析，一行坏了只截断一行，其余完整。这是 Docker log、Nginx access log 的同类选择。」
- 「我没实现自动清理——和 Claude Code 一样。JSONL 文件很小，自动清理会引入误删风险，用户手动 `rm` 更安全。这是显式的工程权衡：把决定权留给用户。」

---
