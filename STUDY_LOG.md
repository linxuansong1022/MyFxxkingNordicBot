# 学习记录表

> 用途：每天记录“今天学了什么、卡在哪里、下一步学什么”。
> 约定：每次学习或复习后，都补一条当天记录。

## 使用方法

- 日期：写当天日期
- 学习内容：今天读了哪些文件、理解了哪些概念
- 关键收获：今天真正搞懂了什么
- 卡点 / 疑问：哪里还不懂，后面继续追
- 下一步：下一次准备学什么

---

## 模板

```md
## YYYY-MM-DD

- 学习内容：
- 关键收获：
- 卡点 / 疑问：
- 下一步：
```

---

## 学习记录

## 2026-04-06

- 学习内容：`src/types.ts`、`src/tool.ts`、`src/agent-loop.ts`、`src/index.ts`、`src/prompt.ts`
- 关键收获：理解了 `ChatMessage`、`ToolCall`、`AgentStep`、`ModelAdapter`，也理解了 `ToolRegistry`、`execute()`、`runAgentTurn()` 和 system prompt 的入口位置。
- 卡点 / 疑问：TypeScript 语法映射还在适应中，尤其是 `Promise`、箭头函数、对象/类方法写法、泛型和带函数类型的字段。
- 下一步：继续读 `model-factory.ts`、`config.ts`，并开始用这个文档做每日学习追踪。

## 2026-04-07

### 上午：源码深入学习

- 学习内容：`src/prompt.ts`（深入）、`src/config.ts`、`src/gemini-adapter.ts`、`src/anthropic-adapter.ts`(对比)、`src/permissions.ts`、`src/index.ts`（重看）
- 关键收获：
  - **Prompt 动态上下文**：理解了 system prompt 不是写死的常量，而是每轮重新生成的"快照"。messages[0] 永远是 system，但每次 refresh 会覆盖。
  - **CLAUDE.md 两层加载**：全局 + 项目，"项目覆盖全局"靠的是 LLM 注意力机制（后出现的指令优先），而不是代码逻辑。
  - **Config 多层合并**：4 个文件 + 环境变量，越具体越优先。`loadRuntimeConfig()` 是唯一入口,输出 `RuntimeConfig` 给全项目用。
  - **Adapter 本质**：翻译官 + 通信员。只做"格式转换 + HTTP 通信"，不做任何业务决策。所有 adapter 实现同一个 `next(messages) → AgentStep` 接口。
  - **真实 HTTP 请求**：用 console.error 打印 requestBody，亲眼看到了 systemInstruction + contents + tools 三块内容。理解了 LLM 是无状态的，每次都重发完整历史。
  - **Permission 系统**：核心套路是"查缓存 → 没有就问 → 记住答案"。三层缓存（turn / session / always）对应三种寿命。`deny_with_feedback` 把"拒绝"变成"对话"，让 AI 根据反馈调整方案。
  - **index.ts 是装配工**：用最朴素的方式把 config / tool / permissions / adapter / prompt 串起来，没有任何花哨的架构。理解了 5 步装配 + 主循环 + 两种 UI 模式。

### 下午：MCP 概念 + 苏格拉底式复盘

- **MCP 概念**：
  - MCP = AI 工具的 USB 接口，让任何 MCP server 都能被任何 client 复用
  - mini-code 是 MCP **client**（消费工具），不是 server（提供工具）
  - 三类能力：tools / resources / prompts，95% 用 tools
  - 两种传输：stdio（启动子进程）+ streamable-http
- **苏格拉底式复盘**：以面试官身份提问，带学生重新过了一遍核心概念
- **关键文档更新**：DEV_SPEC.md 4.0 节新增（index.ts），4.4 / 4.5 / 4.6 / 4.7 节都补充了"学习要点 + Trade-off"。

### 🌟 今天最大的认知突破：Agent 的本质

通过追问"agent 是怎么动手的"，彻底打破了对 AI agent 的"魔法滤镜"：

1. **LLM 只会输出文本**——它跑在 Google/Anthropic 的服务器上，根本看不到你的电脑
2. **agent 是个普通本地程序**——它是 Node.js / Python 写的脚本，本来就有读文件、跑命令的能力
3. **"工具调用"的本质**：LLM 输出 `{ functionCall: 'read_file' }` → adapter 解析成 `AgentStep` → agent-loop 用 if/else 匹配 → 调对应的预写函数 → 函数内部调 Node.js 内置 API → Node.js 调操作系统系统调用 → 真的执行
4. **stdin / stdout 是水管，不需要键盘**——agent 操作其他程序的本质是"接管它们的水管"，跟 shell 用 `|` 接管道是同一原理（如 `echo "hello" | cat`）
5. **"调"一个函数 = 让电脑执行那个函数里预先写好的代码**——agent 没有任何魔法，所有"自主行动"都是程序员预先摆好的多米诺骨牌，LLM 只是推倒第一块

**核心认知**：
> LLM 输出文本 → agent 用预写的 if/else 匹配 → 执行对应的函数。所有"自主行动"都是程序员预先摆好的多米诺骨牌。

### 卡点 / 疑问

- ✅ TypeScript 的 Set 操作、`new Set<string>()` 语法已经习惯
- ✅ permissions.ts 一开始觉得乱，理解"3 个 ensure 函数都是同一套路"后就清晰了
- ✅ "agent 怎么动手"这个核心疑问彻底解决
- ⏳ 还没动手写任何新代码

### 下一步

- **不再纯读源码**——尝试自己写一个新工具（如 `count_lines`），动手实践比继续读模块边际收益更高
- 可选：把上下文压缩功能补上（types.ts 里 `context_summary` 这个 role 是占位的，没真正实现）

---

## 2026-04-07（晚）

### 学习内容：第一次动手写工具 `count_lines`

从零写了 `src/tools/count-lines.ts`，注册进 `ToolRegistry`，跑起来让 LLM 主动调用，完整跑通了"工具定义 → 注册 → LLM 决策 → 本地执行 → 结果回传"的全链路。

### 关键收获

1. **加新工具 = 写一个 ToolDefinition 对象 + 在 `tools/index.ts` 注册一行**——没有任何魔法，没有任何配置文件，没有任何插件机制。就是 import + 数组里加一项
2. **设计工具的核心问题不是"LLM 能不能做"，而是"让 LLM 做要塞多少 token"**——能在本地廉价计算的全部抽成工具，把 O(文件大小) 的 token 开销压成 O(1)
3. **两份 schema 不是冗余**：`inputSchema` (JSON Schema) 跨网络传给 LLM 当合同；`schema` (zod) 是本地的安检门防 LLM 乱传。两个世界的语言不通，必须各写一份
4. **`description` 是产品文案，不是技术注释**——写"prefer X over Y when ..."直接帮 LLM 做决策，比写得正式十倍管用
5. **错误处理分层**：工具内部 throw，`ToolRegistry.execute()` 统一 try/catch 转成 `{ ok: false, output: 错误消息 }`。**不要在每个工具里重复写 try/catch**
6. **tool result 必须自包含**：返回 `FILE: xxx\nLINES: 42` 而不是只返回 `42`，因为 LLM 可能并行调多个工具，结果要脱离 input 也能读懂
7. **永远用异步 IO**：`readFile` (promises) 而不是 `readFileSync`。Node 单线程，同步 API 会卡死整个进程
8. **路径必须过 `resolveToolPath`**：所有跨信任边界的操作都应该收口到一个守门员函数，不要自己拼路径
9. **`tsx` 让 TS 文件可以直接当 JS 跑**：所以这个项目没有 `build` 脚本，开发用 `npm run dev`（其实就是 `tsx src/index.ts`），省了打包步骤

### 🌟 今天最大的认知突破：工具系统的"餐厅模型"

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

LLM 是个永远不进厨房的顾客。所有"自主行动"都是程序员预先摆好的菜单。今天我亲手在菜单上加了一道菜。

### 卡点 / 疑问

- ✅ 一个完整的 ToolDefinition 5 个字段全部理解了
- ✅ 注册流程理解了：写文件 → import → 放数组 → 完事
- ⏳ TUI 渲染 tool result 时只显示了 output 第一行（`LINES: 1305` 那行被截了），但 LLM 收到的是完整的——这是 UI 渲染的小问题，不影响功能

### 下一步

- 进阶版：给 `count_lines` 加 `pattern` 参数（"只数包含某个关键词的行"），体验工具如何演化、参数如何扩展
- 或者：挑战写一个更复杂的工具，比如 `file_stats`（返回行数 + 字符数 + 字节数 + 最后修改时间），练习返回结构化输出
- 远期：补上下文压缩功能（`context_summary` role）
