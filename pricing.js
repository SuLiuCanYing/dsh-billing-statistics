/**
 * 价格解析与计价。
 *
 * 三层来源，优先级从高到低：
 * 1. 插件配置里的 `pricing`（用户手填，覆盖一切）；
 * 2. 官网同步的价格表（price-source.js 抓取，含峰谷时段 / 阶梯价）；
 * 3. 内置参考价（估算，官网抓不到时兜底）。
 *
 * 价格单位统一为「元 / 百万 token」；`currency` 目前均为 CNY。
 */

export const SOURCE_CUSTOM = 'custom'
export const SOURCE_OFFICIAL = 'official'
export const SOURCE_ESTIMATE = 'estimate'
export const SOURCE_NONE = 'none'

export const ZERO_RATE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** 规范化一条价格记录。 */
export function normalizeRate(value) {
  const source = value && typeof value === 'object' ? value : {}
  const pick = (key) => {
    const n = Number(source[key])
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return {
    input: pick('input'),
    output: pick('output'),
    cacheRead: pick('cacheRead'),
    cacheWrite: pick('cacheWrite'),
  }
}

/**
 * 内置参考价（元 / 百万 token，估算）。
 * 2026-11 官网价：硅基流动 DeepSeek-V4.1-Flash 峰时 2/8/0.04、谷时 1/4/0.02；
 * DeepSeek 官方 deepseek-flash 峰时 2/8/0.04、谷时 1/4/0.02。这里取峰时价，仅作抓不到官网时的兜底。
 */
export const DEFAULT_PRICING = Object.freeze({
  'siliconflow/deepseek-ai/DeepSeek-V4-Flash': { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 0 },
  'siliconflow/deepseek-ai/DeepSeek-V4.1-Flash': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
  'siliconflow/deepseek-ai/DeepSeek-V4-Pro': { input: 12, output: 24, cacheRead: 1, cacheWrite: 0 },
  'siliconflow/deepseek-ai/DeepSeek-V3.2': { input: 4, output: 6, cacheRead: 0.4, cacheWrite: 0 },
  'siliconflow/deepseek-ai/DeepSeek-R1': { input: 4, output: 16, cacheRead: 0.8, cacheWrite: 0 },
  'siliconflow/Qwen/Qwen3.8-27B': { input: 3, output: 12, cacheRead: 0, cacheWrite: 0 },
  'siliconflow/zai-org/GLM-5.3': { input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },
  'siliconflow/moonshotai/Kimi-K2.7-Code': { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 0 },
  'siliconflow2/*': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
  'deepseek-official/*': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
  'deepseek-account/*': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
})

/** 北京时间（UTC+8）的「小时 / 星期 / 日期」，用于匹配峰谷时段。 */
export function beijingParts(timestamp) {
  const shifted = new Date(Number(timestamp) + 8 * 3600 * 1000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return {
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
    dayKey: `${year}-${month}-${day}`,
  }
}

/** 计算一次调用的花费（元）；usage 用 harness 的 TokenUsage 约定。 */
export function computeCost(usage, rate) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens) || 0)
  const cacheReadTokens = Math.max(0, Number(usage?.cacheReadTokens) || 0)
  const cacheWriteTokens = Math.max(0, Number(usage?.cacheWriteTokens) || 0)
  const outputTokens = Math.max(0, Number(usage?.outputTokens) || 0)
  const cost =
    (inputTokens * rate.input +
      outputTokens * rate.output +
      cacheReadTokens * rate.cacheRead +
      cacheWriteTokens * rate.cacheWrite) /
    1_000_000
  return Number.isFinite(cost) ? cost : 0
}

/** 把 TokenUsage 归一化为零缺失的对象。 */
export function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {}
  const n = (key) => {
    const value = Number(source[key])
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  const inputTokens = n('inputTokens')
  const outputTokens = n('outputTokens')
  const totalTokens = Number(source.totalTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    cacheReadTokens: n('cacheReadTokens'),
    cacheWriteTokens: n('cacheWriteTokens'),
    reasoningTokens: n('reasoningTokens'),
  }
}

/** 把毫秒时间戳格式化为北京时间 YYYY-MM-DD。 */
export function dayKey(timestamp = Date.now()) {
  return beijingParts(timestamp).dayKey
}

/** 从某个时间点往前 days 天，返回北京时间 YYYY-MM-DD。 */
export function dayKeyBefore(days, timestamp = Date.now()) {
  return dayKey(Number(timestamp) - Math.max(0, days) * 24 * 3600 * 1000)
}

/** 规则是否含峰谷时段/阶梯（用于判断能否按聚合数据重算历史）。 */
export function isComplexRule(rule) {
  return Boolean(rule && ((rule.periods?.length ?? 0) > 0 || (rule.tiers?.length ?? 0) > 0))
}

/**
 * 某一时刻适用的单价。
 * @param {object} rule
 * @param {number} at 毫秒时间戳
 * @param {number} [promptTokens] 输入 token 数（阶梯价用）
 */
export function rateAt(rule, at, promptTokens = 0) {
  if (!rule || rule.source === SOURCE_NONE) return { rate: ZERO_RATE, label: '', peak: false }
  const { hour, weekday, dayKey: day } = beijingParts(at)
  const holiday = Array.isArray(rule.holidays) && rule.holidays.includes(day)

  // 阶梯价：按输入 token 选档；选完档即视为全天统一价。
  let effective = rule
  const tiers = rule.tiers ?? []
  if (tiers.length > 0) {
    const sorted = [...tiers].sort((a, b) => a.maxPrompt - b.maxPrompt)
    const bucket =
      sorted.find((tier) => !Number.isFinite(tier.maxPrompt) || promptTokens <= tier.maxPrompt) ??
      sorted[sorted.length - 1]
    effective = { ...rule, periods: [], defaultRate: bucket.rate, defaultLabel: bucket.label || '' }
  }

  const weight = (rate) => (rate?.input ?? 0) + (rate?.output ?? 0) + (rate?.cacheRead ?? 0)
  const allWeights = [
    ...(effective.periods ?? []).map((period) => weight(period.rate)),
    ...(effective.defaultRate ? [weight(effective.defaultRate)] : []),
  ]
  const distinct = new Set(allWeights.map((value) => value.toFixed(6)))
  const maxWeight = allWeights.length > 0 ? Math.max(...allWeights) : 0
  // 只有一个价位 = 没有峰谷折扣，按「峰时」记，避免把平价说成谷时。
  const markPeak = (rate) => distinct.size <= 1 || weight(rate) >= maxWeight - 1e-9

  for (const period of effective.periods ?? []) {
    const days = Array.isArray(period.days) ? period.days : null
    if (days && (holiday || !days.includes(weekday))) continue
    if (!(period.ranges ?? []).some(([from, to]) => hour >= from && hour < to)) continue
    return { rate: period.rate, label: period.label || '', peak: markPeak(period.rate) }
  }
  if (effective.defaultRate) {
    return { rate: effective.defaultRate, label: effective.defaultLabel || '', peak: markPeak(effective.defaultRate) }
  }
  const first = (effective.periods ?? [])[0]
  if (first) return { rate: first.rate, label: first.label || '', peak: markPeak(first.rate) }
  return { rate: ZERO_RATE, label: '', peak: false }
}

/**
 * 构造计价器。
 * @param {object} options
 * @param {Record<string, unknown>} [options.custom] 插件配置的 pricing
 * @param {Record<string, { models?: Record<string, any>, currency?: string, url?: string }>} [options.providers]
 *   按平台缓存的价格表（prices.json.providers），键就是 provider
 * @param {string[]} [options.holidays] 视为空闲时段的日期（YYYY-MM-DD，北京时间）
 * @param {number} [options.usdToCny] 美元价折算成人民币的汇率（通用页面抓到 $ 价时用）
 */
export function createPricer({ custom = {}, providers = {}, holidays = [], usdToCny = 7.1 } = {}) {
  const customTable = custom && typeof custom === 'object' ? custom : {}
  const tables = providers && typeof providers === 'object' ? providers : {}

  const fromCustom = (provider, model) => {
    for (const key of [`${provider}/${model}`, provider, `${provider}/*`, '*']) {
      if (!Object.prototype.hasOwnProperty.call(customTable, key)) continue
      const rate = normalizeRate(customTable[key])
      if (rate.input || rate.output || rate.cacheRead || rate.cacheWrite) {
        return {
          source: SOURCE_CUSTOM,
          currency: 'CNY',
          periods: [{ label: '', ranges: [[0, 24]], rate }],
          tiers: [],
          feedId: '',
          holidays,
        }
      }
    }
    return null
  }

  /** 把美元价按汇率折成人民币（页面里抓到 $ 价时）。 */
  const toCny = (rate, currency) => {
    if (currency !== 'USD') return rate
    const factor = Number(usdToCny) > 0 ? Number(usdToCny) : 7.1
    return {
      input: rate.input * factor,
      output: rate.output * factor,
      cacheRead: rate.cacheRead * factor,
      cacheWrite: (rate.cacheWrite ?? 0) * factor,
    }
  }

  const fromProvider = (provider, model) => {
    const table = tables[provider]
    if (!table?.models) return null
    const name = table.aliases?.[model] ?? model
    const entry = table.models[name]
    if (!entry) return null
    const currency = entry.currency ?? table.currency ?? 'CNY'
    return {
      source: SOURCE_OFFICIAL,
      currency: 'CNY',
      originalCurrency: currency,
      periods: (entry.periods ?? []).map((period) => ({ ...period, rate: toCny(period.rate, currency) })),
      defaultRate: entry.defaultRate ? toCny(entry.defaultRate, currency) : undefined,
      defaultLabel: entry.defaultLabel || (entry.defaultRate ? '空闲时段' : ''),
      tiers: (entry.tiers ?? []).map((tier) => ({ ...tier, rate: toCny(tier.rate, currency) })),
      free: Boolean(entry.free),
      feedId: table.feedId ?? '',
      url: table.url ?? '',
      holidays,
    }
  }

  const fromEstimate = (provider, model) => {
    for (const key of [`${provider}/${model}`, provider, `${provider}/*`, '*']) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRICING, key)) continue
      const rate = normalizeRate(DEFAULT_PRICING[key])
      if (rate.input || rate.output || rate.cacheRead || rate.cacheWrite) {
        return {
          source: SOURCE_ESTIMATE,
          currency: 'CNY',
          periods: [{ label: '', ranges: [[0, 24]], rate }],
          tiers: [],
          feedId: '',
        }
      }
    }
    return null
  }

  /** 解析某 provider/model 当前生效的价格规则（总是带 source 字段）。 */
  function resolve(provider, model) {
    return (
      fromCustom(provider, model) ??
      fromProvider(provider, model) ??
      fromEstimate(provider, model) ?? {
        source: SOURCE_NONE,
        currency: 'CNY',
        periods: [],
        tiers: [],
        feedId: '',
      }
    )
  }

  /** 某次调用（时间 + 输入长度）的单价与峰谷标签。 */
  function priceFor(provider, model, at, promptTokens = 0) {
    const rule = resolve(provider, model)
    const picked = rateAt(rule, at, promptTokens)
    return { rule, ...picked }
  }

  /** 给 UI 用的价格说明（时段 + 单价）。 */
  function describe(provider, model) {
    const rule = resolve(provider, model)
    return {
      source: rule.source,
      currency: rule.currency,
      originalCurrency: rule.originalCurrency ?? rule.currency,
      url: rule.url ?? '',
      feedId: rule.feedId ?? '',
      periods: (rule.periods ?? []).map((period) => ({
        label: period.label,
        days: period.days,
        ranges: period.ranges,
        rate: period.rate,
      })),
      defaultRate: rule.defaultRate ?? null,
      defaultLabel: rule.defaultLabel ?? '',
      tiers: (rule.tiers ?? []).map((tier) => ({ label: tier.label, maxPrompt: tier.maxPrompt, rate: tier.rate })),
      free: Boolean(rule.free),
    }
  }

  return { resolve, priceFor, describe }
}
