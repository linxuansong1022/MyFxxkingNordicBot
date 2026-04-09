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
