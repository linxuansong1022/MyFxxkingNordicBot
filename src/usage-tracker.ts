// usage-tracker.ts
// 进程级（会话级）的 LLM token 使用统计。
//
// 这个模块持有一个模块级的 let 变量当作"全局计数器"。
// adapter 每次收到 LLM 响应后调 recordUsage()，
// /cost 命令调 getUsageTotals() 读总数。
//
// 为什么用模块级单例：mini-code 是单进程 CLI，整个会话只有一个计数器，
// 不需要依赖注入或类实例化。简单胜过教科书纯洁性。

export type UsageRecord = {
  inputTokens: number   // 输入 token（promptTokenCount）
  outputTokens: number  // 输出 token（candidatesTokenCount + thoughtsTokenCount）
  cachedTokens: number  // 缓存命中的 token（计费打折）
  model: string         // 实际跑的模型版本
}

export type UsageTotals = {
  callCount: number          // 总共调了多少次 LLM
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  estimatedCostUsd: number   // 估算总成本（美元）
  models: string[]           // 本次会话用过哪些模型
}

// --- 模块级状态 ---
// 这是个"会话级单例"——整个 mini-code 进程共享。

let records: UsageRecord[] = []

// turn 快照：记录"当前 turn 开始时" records 的长度。
// 用快照差值算 turn 消耗：getTurnUsage() = 当前累计 - 快照。
// 不给每条 record 打 turn 标签，是因为这种算法改动最小、写入路径无感。
let turnStartIndex = 0

// --- 价格表（每百万 token 美元数）---
// 这些价格是估算值，不同时期不同模型不同。准确价格请查供应商官网。
// 命中缓存的 input token 通常打 1-2.5 折。

type PriceEntry = {
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion: number
}

const PRICE_TABLE: Record<string, PriceEntry> = {
  // --- Gemini 2.5 系列 ---
  'gemini-2.5-flash': {
    inputPerMillion: 0.075,
    outputPerMillion: 0.30,
    cachedInputPerMillion: 0.01875,
  },
  'gemini-2.5-pro': {
    inputPerMillion: 1.25,
    outputPerMillion: 5.00,
    cachedInputPerMillion: 0.3125,
  },

  // --- Anthropic Claude 4.x 系列 ---
  // cachedInputPerMillion 指的是"读缓存"价格（cache_read_input_tokens），
  // 通常是普通 input 价的 10%。写缓存（cache_creation）按普通 input 计价。
  'claude-haiku-4-5': {
    inputPerMillion: 1.00,
    outputPerMillion: 5.00,
    cachedInputPerMillion: 0.10,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cachedInputPerMillion: 0.30,
  },
  'claude-sonnet-4-6': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cachedInputPerMillion: 0.30,
  },
  'claude-opus-4-5': {
    inputPerMillion: 15.00,
    outputPerMillion: 75.00,
    cachedInputPerMillion: 1.50,
  },
  'claude-opus-4-6': {
    inputPerMillion: 15.00,
    outputPerMillion: 75.00,
    cachedInputPerMillion: 1.50,
  },

  // --- OpenAI GPT 系列（估算值，实际价格以 OpenAI 官网为准）---
  'gpt-5-mini': {
    inputPerMillion: 0.25,
    outputPerMillion: 2.00,
    cachedInputPerMillion: 0.025,
  },
  'gpt-5': {
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
    cachedInputPerMillion: 0.125,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.60,
    cachedInputPerMillion: 0.075,
  },
  'gpt-4o': {
    inputPerMillion: 2.50,
    outputPerMillion: 10.00,
    cachedInputPerMillion: 1.25,
  },
}

// 默认价格（模型未在表里时使用）—— 取一个中间水位，避免低估昂贵模型
const DEFAULT_PRICE: PriceEntry = {
  inputPerMillion: 1.00,
  outputPerMillion: 5.00,
  cachedInputPerMillion: 0.10,
}

function priceFor(model: string): PriceEntry {
  // 模糊匹配：模型名可能带后缀（gemini-2.5-flash-001）
  for (const [key, value] of Object.entries(PRICE_TABLE)) {
    if (model.startsWith(key)) {
      return value
    }
  }
  return DEFAULT_PRICE
}

function calcCost(record: UsageRecord): number {
  const price = priceFor(record.model)
  // 真正的"非缓存 input" = 总 input - 缓存命中部分
  const uncachedInput = Math.max(0, record.inputTokens - record.cachedTokens)
  const inputCost = (uncachedInput / 1_000_000) * price.inputPerMillion
  const cachedCost = (record.cachedTokens / 1_000_000) * price.cachedInputPerMillion
  const outputCost = (record.outputTokens / 1_000_000) * price.outputPerMillion
  return inputCost + cachedCost + outputCost
}

// --- 公开 API ---

export function recordUsage(record: UsageRecord): void {
  records = [...records, record]
}

// 把一段 records 切片汇总成 UsageTotals。
// 内部辅助函数，供 getUsageTotals 和 getTurnUsage 复用。
function summarize(slice: UsageRecord[]): UsageTotals {
  const totalInputTokens = slice.reduce((sum, r) => sum + r.inputTokens, 0)
  const totalOutputTokens = slice.reduce((sum, r) => sum + r.outputTokens, 0)
  const totalCachedTokens = slice.reduce((sum, r) => sum + r.cachedTokens, 0)
  const estimatedCostUsd = slice.reduce((sum, r) => sum + calcCost(r), 0)
  const models = [...new Set(slice.map(r => r.model))]

  return {
    callCount: slice.length,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    estimatedCostUsd,
    models,
  }
}

export function getUsageTotals(): UsageTotals {
  return summarize(records)
}

// 标记一个新 turn 开始。把当前 records 长度记下来当快照。
// index.ts 主循环在每条用户输入前调一次。
export function beginTurn(): void {
  turnStartIndex = records.length
}

// 返回从上一次 beginTurn() 到现在的累计消耗。
export function getTurnUsage(): UsageTotals {
  return summarize(records.slice(turnStartIndex))
}

export function resetUsage(): void {
  records = []
  turnStartIndex = 0
}
