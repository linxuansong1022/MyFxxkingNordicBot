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
