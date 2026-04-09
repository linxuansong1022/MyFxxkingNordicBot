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
