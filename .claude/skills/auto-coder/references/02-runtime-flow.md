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
