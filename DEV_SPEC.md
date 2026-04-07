# MiniCode 开发文档

> 基于 [LiuMengxuan04/MiniCode](https://github.com/LiuMengxuan04/MiniCode) 的二次开发项目。
> 本文档记录项目中**已经实现**的所有功能，帮助快速理解代码和后续开发。

---

## 1. 项目是什么

MiniCode 是一个终端 AI 编程助手，核心思路来自 Claude Code。用户在终端输入自然语言，MiniCode 调用 LLM API，LLM 通过工具（读文件、写文件、运行命令等）完成编程任务。

**一句话概括运行逻辑：** 用户说话 → LLM 决定调哪个工具 → 执行工具 → 把结果喂回 LLM → LLM 继续或回答 → 循环直到完成。

**代码规模：** 约 7000 行 TypeScript（`src/` 目录），零框架依赖（不用 React、Express、Ink），全部基于 Node.js 原生 API。

### 学习记录约定

- 仓库内新增了专门的学习追踪文档：[STUDY_LOG.md](/Users/songlinxuan/Desktop/MiniCode/STUDY_LOG.md)
- 每次学习或复习项目源码后，都应同步更新这份文档
- 记录内容至少包括：当天学习内容、关键收获、卡点 / 疑问、下一步
- `LEARNING.md` 用来规划学习路线，`STUDY_LOG.md` 用来跟踪每天实际学了什么

---

## 2. 核心运行流程

```
用户在终端输入一段话
         │
         ▼
┌─ index.ts ─────────────────────────────────────┐
│  1. loadRuntimeConfig()    加载配置             │
│  2. createDefaultToolRegistry()  注册 12 个工具 │
│  3. hydrateMcpTools()      异步连接 MCP 服务器  │
│  4. new PermissionManager()  初始化权限管理      │
│  5. buildSystemPrompt()    组装 system prompt    │
│  6. 判断是否 TTY 终端：                          │
│     ├─ 是 → runTtyApp()  全屏 TUI               │
│     └─ 否 → readline 简易循环                    │
└────────────────────────────────────────────────┘
         │
         ▼ 用户输入一条消息后
         │
┌─ agent-loop.ts ── runAgentTurn() ──────────────┐
│                                                 │
│  for 循环（每次一步）:                            │
│                                                 │
│    ① model.next(messages)                       │
│       把完整消息列表发给 LLM API                  │
│       ↓                                         │
│    ② LLM 返回两种情况：                          │
│       ├─ 纯文本回复 → 显示给用户，循环结束         │
│       └─ 工具调用请求 → 进入 ③                    │
│       ↓                                         │
│    ③ tools.execute(toolName, input)              │
│       校验参数(zod) → 权限检查 → 执行工具         │
│       ↓                                         │
│    ④ 把工具结果追加到 messages，回到 ①             │
│                                                 │
│  额外机制：                                      │
│  - 空响应重试（最多 2 次）                        │
│  - thinking 截断恢复（最多 3 次）                 │
│  - <progress> 标记：LLM 说"还没做完"，循环继续    │
│  - awaitUser：工具暂停循环等用户输入               │
│  - maxSteps：防死循环的步数上限                    │
└─────────────────────────────────────────────────┘
```

**为什么这么设计：** 所有 AI Agent 的核心都是这个"思考→行动→观察"循环。MiniCode 用 277 行代码实现了它，包含了生产环境需要的容错机制（空响应、截断、重试）。

**Trade-off — 初始化顺序：MCP 后台加载 vs 全部等待**

```typescript
const mcpHydration = hydrateMcpTools(...).catch(() => {})  // 不 await，后台加载
await permissions.whenReady()  // 权限必须等
```

| 方案 | 启动速度 | 工具可用性 |
|------|---------|----------|
| **当前：MCP 后台加载** | <1 秒 | 刚启动时 MCP 工具不可用 |
| 全部 await | 3-5 秒 | 启动即全部可用 |
| 全部懒加载 | 最快 | 第一次调工具卡一下 |

选当前方案的原因：用户打开终端希望立刻能用，MCP 工具在第一次对话前大概率已经加载完。通过 `refreshSystemPrompt()` 每轮刷新来解决"晚到的工具"问题。

---

## 3. 项目目录结构

```
src/
├── index.ts                 # 入口：启动配置+模型+工具+权限，进入主循环
├── agent-loop.ts            # [核心] 多轮工具调用循环（277行）
├── types.ts                 # 类型定义：ChatMessage、ModelAdapter、AgentStep
├── tool.ts                  # ToolRegistry 类：工具注册/查找/校验/执行
├── anthropic-adapter.ts     # Anthropic Messages API 适配器（HTTP+重试）
├── mock-model.ts            # 离线模拟适配器（不需要 API key 就能跑）
├── config.ts                # 多层配置加载与合并
├── prompt.ts                # 组装 system prompt
├── permissions.ts           # 权限管理（路径/命令/编辑三类审批）
├── file-review.ts           # 写文件前生成 diff 预览
├── workspace.ts             # 路径解析 + 越界检查
├── mcp.ts                   # MCP 客户端（stdio + HTTP 两种传输）
├── mcp-status.ts            # MCP 连接状态统计
├── skills.ts                # Skill 发现与加载（SKILL.md）
├── cli-commands.ts          # slash 命令定义与处理
├── manage-cli.ts            # 管理命令（minicode mcp add/remove 等）
├── install.ts               # 交互式安装器
├── history.ts               # 输入历史持久化（最近 200 条）
├── background-tasks.ts      # 后台 shell 任务注册与状态跟踪
├── local-tool-shortcuts.ts  # /ls /grep /read 等快捷命令解析
├── tty-app.ts               # 全屏 TUI 应用主逻辑（最大文件，1342行）
├── ui.ts                    # UI 渲染函数的统一导出
│
├── tools/                   # 内置工具（每个文件一个工具）
│   ├── index.ts             # 注册入口：把 12 个工具装入 ToolRegistry
│   ├── ask-user.ts          # 向用户提问，暂停循环
│   ├── read-file.ts         # 读文件（支持 offset/limit 分页）
│   ├── write-file.ts        # 写新文件（经过 diff review）
│   ├── edit-file.ts         # 精确字符串替换
│   ├── modify-file.ts       # 整文件替换（经过 diff review）
│   ├── patch-file.ts        # 批量替换（多个 search/replace 一次执行）
│   ├── list-files.ts        # 列目录（最多 200 条）
│   ├── grep-files.ts        # ripgrep 搜索
│   ├── run-command.ts       # 执行 shell 命令（白名单+危险检测）
│   ├── load-skill.ts        # 加载 SKILL.md 内容
│   ├── web-fetch.ts         # 抓取网页文本
│   └── web-search.ts        # DuckDuckGo + 搜狗双引擎搜索
│
├── tui/                     # 终端 UI 组件
│   ├── types.ts             # TranscriptEntry 类型
│   ├── chrome.ts            # 面板边框/Banner/状态栏渲染
│   ├── screen.ts            # 终端屏幕控制（光标/清屏/备用屏幕）
│   ├── input.ts             # 输入行为
│   ├── input-parser.ts      # 终端转义序列解析（方向键/Ctrl等）
│   ├── transcript.ts        # 对话记录渲染
│   ├── markdown.ts          # 简易 Markdown 渲染
│   └── index.ts             # TUI 导出
│
└── utils/
    ├── errors.ts            # 错误码提取（ENOENT 等）
    └── web.ts               # HTTP 请求+搜索引擎爬虫（506行）
```

---

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

## 5. 消息流转示例

假设用户输入"读取 README.md"，完整的消息流转：

```
messages = [
  { role: 'system', content: 'You are mini-code...' },
  { role: 'user', content: '读取 README.md' },
]

→ model.next(messages) 返回:
  { type: 'tool_calls', calls: [{ toolName: 'read_file', input: { path: 'README.md' } }] }

→ tools.execute('read_file', { path: 'README.md' }) 返回:
  { ok: true, output: 'FILE: README.md\n...' }

→ messages 变成:
  [...原来的, assistant_tool_call, tool_result]

→ model.next(messages) 返回:
  { type: 'assistant', content: '这是 README.md 的内容：...' }

→ 循环结束，显示给用户
```

---

## 6. 技术栈

| 依赖 | 用途 | 为什么选它 |
|------|------|-----------|
| TypeScript | 开发语言 | 类型安全 |
| tsx | 开发时直接跑 .ts（不用编译） | 快速迭代 |
| zod | 工具参数运行时校验 | 比手写校验更安全简洁 |
| diff | 文件编辑 diff 生成 | 生成 unified diff 格式 |
| Node.js 原生 | fs/child_process/readline/http | 零额外依赖 |

**刻意不用的东西：** Express（不是 web 服务）、React/Ink（TUI 手写更可控）、Commander（CLI 参数太少不值得）、axios（fetch 足够）。

---

## 7. 配置文件速查

| 文件 | 路径 | 内容 |
|------|------|------|
| 全局设置 | `~/.mini-code/settings.json` | model、API URL、token |
| MCP 配置 | `~/.mini-code/mcp.json` | 全局 MCP 服务器 |
| 项目 MCP | `./.mcp.json` | 当前项目的 MCP 服务器 |
| 权限 | `~/.mini-code/permissions.json` | 持久化的允许/拒绝规则 |
| MCP token | `~/.mini-code/mcp-tokens.json` | MCP bearer token |
| 协议缓存 | `~/.mini-code/mcp-protocol-cache.json` | stdio 协议协商结果缓存 |
| 输入历史 | `~/.mini-code/history.json` | 最近 200 条命令 |

---

## 8. 启动命令

```bash
npm run dev                              # 开发模式（tsx 直接跑）
MINI_CODE_MODEL_MODE=mock npm run dev    # 离线 mock 模式
npm run check                            # TypeScript 类型检查
npm run install-local                    # 交互式安装
```

---

## 9. Slash 命令一览

**交互式命令（在 TUI 内使用）：**

| 命令 | 功能 |
|------|------|
| `/help` | 显示所有命令 |
| `/tools` | 列出已注册工具 |
| `/skills` | 列出已发现的 skill |
| `/mcp` | 显示 MCP 连接状态 |
| `/status` | 显示当前模型和配置来源 |
| `/model` | 显示当前模型 |
| `/model <name>` | 持久化切换模型 |
| `/config-paths` | 显示配置文件路径 |
| `/permissions` | 显示权限存储路径 |
| `/exit` | 退出 |

**工具快捷命令（直接调用工具，跳过 LLM）：**

| 命令 | 等价工具 |
|------|---------|
| `/ls [path]` | `list_files` |
| `/grep <pattern>::[path]` | `grep_files` |
| `/read <path>` | `read_file` |
| `/write <path>::<content>` | `write_file` |
| `/modify <path>::<content>` | `modify_file` |
| `/edit <path>::<search>::<replace>` | `edit_file` |
| `/patch <path>::<s1>::<r1>::<s2>::<r2>` | `patch_file` |
| `/cmd [cwd::]<command> [args]` | `run_command` |
