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
| `/cost` | 显示当前 session 的 token 用量与估算成本 |
| `/cost reset` | 重置 session token 计数器 |
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
