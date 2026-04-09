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

---

## 2026-04-07（深夜）

### 学习内容：HTTP 报文实战 + 第一个跨模块 feature `/cost`

#### 1. 看见 LLM API 的"实物"——HTTP 报文层面祛魅
在 `gemini-adapter.ts` 里临时加 console.error 打 requestBody/responseBody，亲眼看到了一次 count_lines 调用的全部 4 个 JSON 块（2 个 REQUEST + 2 个 RESPONSE）。然后逐字段拆解了第一个 RESPONSE 的所有字段。

**最大的视觉冲击**：
- LLM 输出的 functionCall **就是一段 JSON 文本**，没有任何"执行能力"。它对 Google 的服务器来说是死的字节
- system prompt **不在 contents 里**，而被 Gemini 单独提到 systemInstruction（每家供应商规则不同）
- 工具菜单是**显式塞进请求**的——adapter 把 ToolRegistry 里所有工具的 name+description+inputSchema 序列化成 functionDeclarations
- type 大小写：你写 `'object'`，发出去变成 `'OBJECT'`——adapter 的 `normalizeSchemaForGemini` 在做翻译。**这就是 adapter 存在的意义**：抹平供应商的怪癖
- **第二跳重发整个对话历史**——LLM 是字面意义上的无状态，1483 token 里只有 ~10 个是用户的实际问题，其余全是工具描述 + system prompt
- usageMetadata 里的 thoughtsTokenCount = Gemini 2.5 推理模型的"内部思考"token，要按 output 价格收费

#### 2. 第一个跨模块 feature：`/cost` 命令
昨天的 count_lines 只触碰一个模块（写工具）。今天的 `/cost` 触碰了 3 个模块——这是质变：

**问题**：怎么让 adapter 收到的账单（usageMetadata）流到 cli-commands 里的 `/cost` 命令？两个互不认识的模块怎么交换数据？

**方案**：引入第三方中立模块 `usage-tracker.ts` 当"共享小本子"——adapter 来这里**写**，cli-commands 来这里**读**，两边互不见面。

**关键设计决策**：
- **模块级单例**（`let records = []`）—— mini-code 是单进程 CLI，不需要 IoC 容器
- **immutable update**（`records = [...records, x]` 而不是 `push`）—— 旧快照不受新写入影响
- **写入/读取类型分离**（`UsageRecord` vs `UsageTotals`）—— 两边的关注点不同，类型即接口
- **辅助功能不报错**（缺字段就 `?? 0`，模型不在价格表就用默认价）—— 估算 > 准确，标 `~` 表示估算
- **adapter 对外接口完全不变** —— agent-loop 完全不知道 tracker 存在。这是"扩展开放、修改封闭"的实战写法

#### 3. 升级版：turn 级 `/cost`
追加了"刚才那一句话花了多少"的视图。用**快照差值模式**实现：不给每条 record 打 turn 标签，而是在 turn 开始时记下"当前 records 长度"，查询时用 `records.slice(快照)` 拿这个 turn 内新增的所有记录。

跟现有的 `permissions.beginTurn()` 是同一个抽象，认知负担小。

**踩了一个细节坑**：原本只想改 `index.ts` 主循环加 `beginUsageTurn()`，结果发现 TUI 模式（`tty-app.ts`）也调了 `permissions.beginTurn()`，必须同步加。**这就是为什么改成对修改的代码要先 grep**——TS 编译器抓不出"漏改一处"这种 bug。

#### 4. 工程习惯升级：dev_spec 驱动开发
今天起改成"先写文档再写代码"。把已经实现但漏文档的 count_lines / `/cost` / usage-tracker 全部回填进 DEV_SPEC.md：
- §4.12 加了"元数据工具"分类列出 count_lines
- §4.16 整节新建 usage-tracker 的设计文档（含设计决策表、数据流图、当前局限、扩展方向）
- §9 加了 `/cost` 和 `/cost reset`

turn 升级版按新规则做：先在 DEV_SPEC.md §4.16 里写完整设计（含三种粒度对比、快照差值原理、改动范围、新输出格式、边界情况），用户确认后再写代码。

### 🌟 今天最大的认知突破

**LLM agent 系统在网络层只有 JSON。所有"智能"和"自主性"都是在 JSON 之间，由本地代码用 if/else + 循环编织出来的。**

LLM 不是 agent。LLM 是一个**给定 JSON 输入返回 JSON 输出的纯函数**。Agent 是包在 LLM 外面的那个 while 循环——这个循环负责：解析输出 → 执行工具 → 把结果塞回输入 → 再调一次。

mini-code 里所有"看起来很聪明"的东西，本质都是这个循环的产物。

### 跨模块 feature 的"餐厅模型"扩展版

| 角色 | 类比 |
|---|---|
| LLM API | 总厨房（远在天边，只看订单不见客人） |
| ToolDefinition | 菜单上的菜 |
| usage-tracker | **柜台上的账本**（收银员记一笔，老板看总账） |
| gemini-adapter | 收银员（每收一单往账本上记） |
| `/cost` 命令 | 老板（晚上想看今天卖了多少） |
| 模块互不认识 | 收银员和老板不用打电话 —— 账本是中立的交换地 |

### 卡点 / 疑问

- ✅ HTTP 报文结构、function calling 的 wire format 都看明白了
- ✅ 跨模块数据流（写在 A 处，读在 B 处，中间放容器）的模式吃透了
- ✅ 文档驱动开发的工作流建立起来了
- ⏳ 目前 `/cost` 只接入了 Gemini adapter，Claude 和 OpenAI adapter 还没接入

### 下一步

- 把 usage-tracker 接入 anthropic-adapter 和 openai-adapter（重复同样的 import + 写入逻辑，几行代码的事）
- 或者再做一个跨模块 feature，比如 `/save` 把当前对话导出成 markdown 笔记
- 或者：精读 agent-loop.ts，理解多步循环（多跳）是怎么终止的、并行 toolCall 怎么处理

---

## 2026-04-08

### 学习内容：三家 adapter 的 usage 字段对比 + `/cost` 全线打通

承接昨晚的 TODO，把 usage-tracker 接入了 `anthropic-adapter.ts` 和 `openai-adapter.ts`。但真正的学习收获不是那几行代码——而是**对比三家供应商的账单字段时发现的"表面一样，内部全是坑"**。

### 🌟 三家 usage 字段的三个大坑

#### 坑 1：推理 token 在哪里记，规则完全不一样

| 家 | 推理 token 字段 | 在不在 output 里？ |
|---|---|---|
| Gemini 2.5 | `thoughtsTokenCount`（单独） | **不在**，需手动加 |
| Anthropic | extended thinking | **已内含** |
| OpenAI o1/o3 | reasoning tokens | **已内含** |

所以 Gemini adapter 要写 `candidatesTokenCount + thoughtsTokenCount`，另外两家直接取 `output_tokens` / `completion_tokens` 就行。**如果你不看文档只凭直觉，Gemini 这条一定会漏算**——用户会看到 `/cost` 比实际低很多。

#### 坑 2：`input_tokens` 到底包不包含缓存

我本来以为这是一个简单字段，结果三家的定义是反的：

| 家 | 缓存关系 |
|---|---|
| Gemini | `promptTokenCount` **包含** `cachedContentTokenCount`（子集） |
| OpenAI | `prompt_tokens` **包含** `cached_tokens`（子集） |
| **Anthropic** | `input_tokens` **不包含** `cache_read_input_tokens`（并集） |

这直接影响 tracker 的公式 `uncachedInput = inputTokens - cachedTokens`：
- Gemini / OpenAI：公式正确
- **Anthropic：公式会把"非缓存 input"算成全部，把缓存部分漏掉**

修法：在 Anthropic adapter 里写入时，手动把三个字段相加当作 `inputTokens`。这样 tracker 的统一公式就适用了。**这就是 adapter 存在的意义**——把各家的怪癖翻译成一个统一的内部表达。

#### 坑 3：Anthropic 有"写缓存" vs "读缓存"两个字段

- `cache_creation_input_tokens`：**写缓存**，比普通 input 贵 25%（因为要开缓存条目）
- `cache_read_input_tokens`：**读缓存**，只要普通 input 的 10%

我们 tracker 的 `cachedTokens` 只代表"读缓存"的折扣部分。写缓存按普通 input 计价（略微低估，但简化了模型）——这是一个**明示的局限**，写进了 DEV_SPEC 的"当前局限"小节。以后需要精确账单时再加 `cacheWriteTokens` 字段和对应价位。

### 关键认知

**LLM 供应商的 API 就算都叫 "usage"，字段语义也会各自发明一套**。adapter 的真正价值不是"翻译消息格式"——那只是表象——而是**把所有供应商的怪癖压到统一的内部模型里**，让上层代码（tracker / `/cost` / 将来的 UI）只需要懂一套语义。

这也解释了为什么 adapter 这个抽象层必须存在：即便三家 API 都是 REST + JSON + 都返回 usage，只要字段语义一不一致，上层就不能复用代码——必须有"抹平层"兜底。

### 工程习惯验证

继续按"先改 DEV_SPEC 再改代码"的 doc-driven 流程。今天的执行顺序：
1. 先在 §4.16 补完"三家 adapter 的 usage 字段对照表"（含三个坑的说明）
2. 更新"当前局限" + "扩展方向"
3. 再改 `usage-tracker.ts` 扩展 PRICE_TABLE
4. 最后改两个 adapter
5. `npx tsc --noEmit` 通过

**收获**：写对照表时被迫查了三家文档，这个过程本身就是最好的学习——比直接写代码获得的理解深一倍。

### 卡点 / 疑问

- ✅ 三家 usage 字段差异彻底理清了
- ✅ 理解了 adapter 的"抹平怪癖"本质（不只是"格式转换"）
- ⏳ 没有用真实 Claude / GPT API key 跑端到端验证（需要 user 手动切模型验证 `/cost` 数字）
- ⏳ PRICE_TABLE 里 GPT-5 的价格是估算——正式使用前要去 OpenAI 官网核对

### 下一步

- **端到端验证**：切到 Claude 或 GPT 模型跑一轮对话，`/cost` 验证数字合理
- 精读 agent-loop.ts 的错误恢复路径（`emptyResponseRetryCount` / `recoverableThinkingRetryCount` / `awaitUser`）—— 纯理解，不写代码
- 远期：做第二个跨模块 feature `/save`，或补上下文压缩（`context_summary` role）

---

## 2026-04-09

### 今天做了啥

- **打磨 auto-coder skill**：把从其他 Python 项目迁移过来的 skill 改造成对齐 MiniCode（TS + `tsx` + doc-driven 6 阶段流程 + 对应 DEV_SPEC 9 章节）
- **用 dev-spec skill 深度打磨 §4.17 上下文压缩**，解决了 10/13 个待决问题：
  - 铁律 #1：`tool_call` / `tool_result` 配对约束（协议层 + 幻觉风险）
  - 三层架构（Tier 1 零成本清理 + Tier 2 LLM 摘要 + Tier 3-Lite 结构化简化版）
  - 实施细节：占用率字符估算、摘要模型 context 约束、双阈值 60%/87%/95%、熔断
  - Pair Guard 算法（O(N) 线性扫描 + 永远往前走）
  - Tier 1 规则从 3 条合并成 2 条（幂等只读去重 + 连续失败去重）
  - Chain-of-Thought 概念 + Tier 3-Lite 为什么能安全剥离 `assistant_progress`
- **新增 §4.18 会话持久化占位**（未来 feature，架构参考 Claude Code 的 `~/.claude/projects/<hash>/sessions/<id>/` 三文件结构）
- **避免了一次 scope creep**：发现"压缩视角的审计" vs "跨进程持久化"是两个独立 feature，划清边界

### 认知收获（压缩话题）

- 上下文压缩本质上是"预测每条信息的未来重要性"——所有策略都是对 `P` 的不同启发式
- Claude Code 的聪明在于把 `P` 估计外包给 LLM 本身（让摘要模型自己判断该保留什么）
- 层级压缩的核心哲学：**不同强度的压缩对应不同成本，先便宜后贵**
- 零成本机械层 vs 有成本语义层的职责分工（Tier 1 vs Tier 2）

### 下一步

- §4.17 还剩 2 个待决问题：**安全名单完整定义**（非幂等 `run_command` 用正则还是关键字）+ **摘要 prompt 设计**（Tier 2 和 Tier 3-Lite 各一个）
- 这 2 个讨论完 → §4.17 完整 → 开始排 feature 的实施顺序 → 动代码
