# MiniCode 开发文档

> 基于 [LiuMengxuan04/MiniCode](https://github.com/LiuMengxuan04/MiniCode) 的二次开发项目。
> 本文档记录项目中**已经实现**的所有功能，帮助快速理解代码和后续开发。

---

## 1. 项目是什么

MiniCode 是一个终端 AI 编程助手，核心思路来自 Claude Code。用户在终端输入自然语言，MiniCode 调用 LLM API，LLM 通过工具（读文件、写文件、运行命令等）完成编程任务。

**一句话概括运行逻辑：** 用户说话 → LLM 决定调哪个工具 → 执行工具 → 把结果喂回 LLM → LLM 继续或回答 → 循环直到完成。

**代码规模：** 约 7000 行 TypeScript（`src/` 目录），零框架依赖（不用 React、Express、Ink），全部基于 Node.js 原生 API。

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

---

### 4.4 Anthropic Adapter（anthropic-adapter.ts — 340 行）

负责把内部的 `ChatMessage[]` 转换成 Anthropic Messages API 的格式，发 HTTP 请求，解析响应。

**做了什么：**
1. **格式转换：** 内部的 6 种消息角色 → Anthropic 的 user/assistant 两种角色 + content blocks
2. **`<progress>` / `<final>` 解析：** LLM 用这些标记表示消息是中间进度还是最终回答
3. **HTTP 重试：** 429（限流）和 5xx（服务器错误）自动重试，指数退避，支持 `Retry-After` 头
4. **双认证：** 支持 `x-api-key`（Anthropic 直连）和 `Bearer` token（兼容端点）

**消息合并规则：** Anthropic API 要求同角色消息不能连续出现。Adapter 自动把连续的同角色消息合并到一个 `content` 数组里。

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

---

### 4.7 System Prompt（prompt.ts — 114 行）

组装发给 LLM 的 system prompt，告诉它：
- 你是 mini-code，一个终端编码助手
- 当前工作目录是哪
- 有哪些权限规则
- 有哪些可用的 skill
- 有哪些 MCP 服务器已连接
- 用户的全局指令（`~/.claude/CLAUDE.md`）
- 项目级指令（`./CLAUDE.md`）
- 响应协议：用 `<progress>` 表示"还在做"，用 `<final>` 表示"做完了"

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
