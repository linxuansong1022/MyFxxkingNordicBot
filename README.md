# MyBloodyNordicBot

> A spec-driven terminal AI coding agent, forked and reshaped from [MiniCode](https://github.com/LiuMengxuan04/MiniCode).

Building this to **understand Claude Code from the inside**, not just use it.

Named after *My Bloody Valentine* — **loveless, noisy, not for everyone**.

---

## 这是什么

不是一个产品，是一个**学习项目**。

目标：通过亲手实现 Claude Code 的核心机制（agent loop / 多模型 adapter / 工具调用 / 上下文压缩 / 评估框架），从"会用"升级到"搞懂为什么这样写"。

基于 [MiniCode](https://github.com/LiuMengxuan04/MiniCode) 二次开发——保留它精简的架构骨架，在上面叠一整套**文档驱动 + 可评估**的工程工作流。

---

## 工程哲学

### Spec-driven development. 先写文档，再写代码。

每一个 feature 都走完整的 6 阶段流水线：

```
Reconnoiter → DEV_SPEC First → Code → Type-check → STUDY_LOG → Verify
```

三个自研 skill 把流水线固化下来：

| Skill | 做什么 |
|---|---|
| **dev-spec** | Socratic 对话打磨 `DEV_SPEC.md`——每个技术决策都要给出方案对比、历史背景、面试话术 |
| **auto-coder** | 按 DEV_SPEC 实施代码——每步 `tsc` 验证，commit 前强制暂停等人工确认 |
| **qa-tester** | 类型检查 → 单元测试 → 任务评估 → 手动 smoke 清单——按 Karpathy 四分类（understand / plan / execute / evaluate）归纳失败 |

### 真实世界是最终法官

任何"看起来对"的方案都要在终端里跑过才算数。评估不是打分，是**找出系统在什么条件下会静默失败**。

---

## 现状

### 在 MiniCode 基础上已新增的

**代码层**：

- `usage-tracker.ts` — 带 turn 级粒度的 token 和成本跟踪，三家 adapter（Gemini / Anthropic / OpenAI）全部接入
- `/cost` 命令 — 显示 "Last turn" 和 "Session total" 双视图
- `/clear` 命令 — 清空对话历史、保留 system prompt
- `count_lines` 工具 — 廉价的本地行数统计

**文档层**（这是大头——这个项目的核心产出）：

- **§4.17 上下文压缩 spec** — 完整的三层架构（Tier 1 本地清理 + Tier 2 LLM 摘要 + Tier 3-Lite 结构化压缩），13 个子问题全部解决
  - 铁律 #1：`tool_call ↔ tool_result` 配对约束的协议层 + 幻觉层解释
  - Pair Guard 算法（O(N) 线性扫描 + 永远往前走）
  - Fail Closed 安全名单
  - Tier 2 / Tier 3-Lite 完整摘要 prompt 模板
- **§4.18 会话持久化** — Claude Code 真实 `~/.claude/projects/<hash>/sessions/` 架构参考（待实施）
- **§10 测试与评估策略** — Karpathy 风格的 agent 评估框架，含评估金字塔、五大 scalar 指标、失败四分类、演进路线

**工具链**：

- 三个对齐本项目的 skill（在 `.claude/skills/` 下）
- `tests/evals/reports/` 目录 + 第一份 QA 报告

### 计划中（按优先级）

```
1. §4.17 Tier 1 本地清理器              (spec 完整，待编码 ← 下一个)
2. §4.17 Tier 2 LLM 摘要 + 近窗
3. §4.17 Tier 3-Lite 极端压缩
4. §4.18 会话持久化（transcript.jsonl + /restore）
5. /save 命令（导出对话为 markdown）
6. tests/evals/ 基础设施 + 第一批 golden task
7. /model 运行时切换
8. 子 agent 编排
```

**迭代节奏**：一次只做一个 feature，每个都走完整的 spec → code → qa → commit 闭环。**不搞 big-bang 瀑布**。

---

## 快速开始

```bash
npm install
npm run install-local
minicode
```

### 开发模式

```bash
npm run dev                              # 正常模式（需要 API key）
MINI_CODE_MODEL_MODE=mock npm run dev    # 离线 mock 模式
npm run check                            # tsc --noEmit
```

---

## 深入阅读

推荐这个阅读顺序：

1. **[`DEV_SPEC.md`](./DEV_SPEC.md)** — 完整架构文档，3000+ 行。每章都有设计决策表、trade-off 分析和面试金句。核心看点：
   - §4 各模块详解
   - §4.17 上下文压缩（最硬核的一章）
   - §10 测试与评估策略
2. **[`STUDY_LOG.md`](./STUDY_LOG.md)** — 按日记录的学习笔记 + 认知突破时刻
3. **[`.claude/skills/`](./.claude/skills/)** — 三个自研 skill 的 SKILL.md 源码
4. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — 上游 MiniCode 的简洁架构概览
5. **[`README.zh-CN.md`](./README.zh-CN.md)** — 上游 MiniCode 的完整中文文档（功能清单、MCP 配置等）

---

## 上游 & 致谢

基于 **[MiniCode](https://github.com/LiuMengxuan04/MiniCode)** by [@LiuMengxuan04](https://github.com/LiuMengxuan04)。

MiniCode 提供了精简的 agent loop 骨架和 TUI。本项目在其上叠加 spec 驱动方法论、评估框架、压缩设计、skill 工作流——都是**在原作者的地基上继续学习和实验**。

License 继承自 [LICENSE](./LICENSE)。

---

*Loveless. Noisy. Not for everyone.*
