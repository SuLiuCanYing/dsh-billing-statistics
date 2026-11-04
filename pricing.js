/**
 * 价格解析与计价。
 *
 * 来源，优先级从高到低：
 * 1. 插件配置里的 `pricing`（用户手填，覆盖一切）；
 * 2. 人工导入价格（manual）；
 * 3. DeepSeek 官方 API 自动价（official，仅官方 provider）；
 * 4. models.dev 目录价格（catalog，含跨平台参考价）；
 * 5. 内置参考价（估算，目录没匹配时兜底）。
 *
 * 价格单位统一为「元 / 百万 token」；models.dev 的美元价在计价器里按汇率折算。
 */

export const SOURCE_CUSTOM = 'custom'
export const SOURCE_OFFICIAL = 'official'
export const SOURCE_CATALOG = 'catalog'
export const SOURCE_MANUAL = 'manual'
export const SOURCE_ESTIMATE = 'estimate'
export const SOURCE_NONE = 'none'

export const ZERO_RATE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function hasRate(rate) {
  return Boolean(rate && (rate.input || rate.output || rate.cacheRead || rate.cacheWrite))
}

function padHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`
}

/** 峰时时段显示成「09:00-12:00、14:00-18:00」。 */
export function formatPeakRanges(ranges) {
  return (ranges ?? []).map(([from, to]) => `${padHour(from)}-${padHour(to)}`).join('、')
}

/** 峰时适用日期的中文说明；null / 七天都算每天。 */
export function peakDaysLabel(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length === 7) return '每天'
  const set = new Set(days)
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return '工作日'
  if (set.size === 2 && set.has(0) && set.has(6)) return '周末'
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return days.map((day) => names[day] ?? `周${day}`).join('、')
}

/**
 * 校验人工导入的峰时设置：
 * `{ ranges: [[9,12],[14,18]], days: [1,2,3,4,5] }`。
 * 时段按整点，结束可写 24；ranges 为空表示不启用峰时。
 */
export function normalizeManualPeak(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('峰时设置格式不对')
  const rawRanges = Array.isArray(value.ranges) ? value.ranges : []
  const ranges = []
  const seen = new Set()
  for (const item of rawRanges) {
    const pair = Array.isArray(item) ? item : [item?.from, item?.to]
    const from = Number(pair[0])
    const to = Number(pair[1])
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 24 || from >= to) {
      throw new Error('峰时时段格式不对：按整点填写，例如 09:00-12:00')
    }
    const key = `${from}-${to}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push([from, to])
  }
  if (ranges.length === 0) return null
  ranges.sort((a, b) => a[0] - b[0])
  let days = null
  if (Array.isArray(value.days) && value.days.length > 0) {
    const unique = [...new Set(value.days.map((day) => Number(day)))]
    if (unique.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('峰时适用日期格式不对')
    }
    unique.sort((a, b) => a - b)
    if (unique.length < 7) days = unique
  }
  return {
    ranges,
    days,
    label: `${formatPeakRanges(ranges)}（${peakDaysLabel(days)}）`,
  }
}

/** 用基础价 + 可选峰时价生成一条人工价格记录；峰时价全 0 表示全天统一价。 */
function manualPriceEntry(id, base, high, currency, plan) {
  const baseRate = normalizeRate(base)
  const peakRate = normalizeRate(high)
  if (!hasRate(baseRate) && !hasRate(peakRate)) throw new Error(`模型 ${id} 没有有效价格`)
  if (hasRate(peakRate) && !hasRate(baseRate)) throw new Error(`模型 ${id} 有峰时价但基础价为 0`)
  if (hasRate(peakRate) && !plan) throw new Error(`模型 ${id} 填了峰时价，但没有设置峰时时段`)
  const periods = []
  if (hasRate(peakRate) && plan) {
    periods.push({
      label: `峰时 ${plan.label}`,
      ranges: plan.ranges,
      ...(plan.days ? { days: plan.days } : {}),
      rate: peakRate,
    })
  }
  periods.push({
    label: hasRate(peakRate) ? '谷时/其他时段' : '人工导入价格',
    ranges: [[0, 24]],
    rate: baseRate,
  })
  return {
    currency,
    origin: 'manual',
    free: false,
    periods,
    tiers: [],
  }
}

/** 从旧人工价里取出基础价（全天时段优先）。 */
function baseRateOf(entry) {
  const periods = Array.isArray(entry?.periods) ? entry.periods : []
  const full = periods.find((period) => (period.ranges ?? []).some(([from, to]) => from === 0 && to === 24))
  return full?.rate ?? entry?.defaultRate ?? periods[periods.length - 1]?.rate ?? {}
}

/** 从旧人工价里取出峰时价。 */
function peakRateOf(entry) {
  const periods = Array.isArray(entry?.periods) ? entry.periods : []
  const peak = periods.find(
    (period) =>
      String(period.label ?? '').startsWith('峰时') ||
      (period.ranges ?? []).some(([from, to]) => !(from === 0 && to === 24)),
  )
  return peak?.rate ?? {}
}


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
 * 把人工导入的简化价格表转成 prices.json 的 provider.models 结构。
 * 输入形如 `{ "model-id": { input, output, cacheRead, cacheWrite, peakInput, ... } }`；
 * 也可以带 `{ rate: {...}, peak: {...} }`。峰时价可省略。
 * `peak` 是 `{ ranges, days }`，见 normalizeManualPeak。
 */
export function normalizeManualPriceModels(input, { currency = 'CNY', peak = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('价格表必须是「模型 ID → 单价」的对象')
  const curr = currency === 'USD' ? 'USD' : 'CNY'
  const plan = normalizeManualPeak(peak)
  const models = {}
  for (const [rawId, rawValue] of Object.entries(input)) {
    const id = String(rawId ?? '').trim()
    if (!id || id.length > 200) throw new Error('模型 ID 为空或过长')
    const raw = rawValue?.rate ?? rawValue ?? {}
    const base = normalizeRate(raw)
    const high = normalizeRate(
      rawValue?.peak ?? {
        input: raw.peakInput ?? rawValue?.peakInput,
        output: raw.peakOutput ?? rawValue?.peakOutput,
        cacheRead: raw.peakCacheRead ?? rawValue?.peakCacheRead,
        cacheWrite: raw.peakCacheWrite ?? rawValue?.peakCacheWrite,
      },
    )
    models[id] = manualPriceEntry(id, base, high, curr, plan)
  }
  if (Object.keys(models).length === 0) throw new Error('没有可导入的模型价格')
  return models
}

/** 人工导入只覆盖本次填写的模型，未填写的旧人工价保留。 */
export function mergeManualPriceModels(previous, normalized) {
  return { ...(previous ?? {}), ...(normalized ?? {}) }
}

/** 峰时时段改了以后，把旧人工价的峰时 / 基础价搬到新时段上。 */
export function retimeManualPriceModels(models, peak = null) {
  const plan = normalizeManualPeak(peak)
  const result = {}
  for (const [id, entry] of Object.entries(models ?? {})) {
    try {
      result[id] = manualPriceEntry(id, baseRateOf(entry), plan ? peakRateOf(entry) : {}, entry?.currency ?? 'CNY', plan)
    } catch {
      result[id] = entry
    }
  }
  return result
}

/**
 * 内置参考价（元 / 百万 token，估算）。
 * 2026-11 公开价：硅基流动 DeepSeek-V4.1-Flash 峰时 2/8/0.04、谷时 1/4/0.02；
 * DeepSeek 官方 deepseek-flash 峰时 2/8/0.04、谷时 1/4/0.02。这里取峰时价，仅作 models.dev 未匹配时的兜底。
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
  // DeepSeek 官方账号 deepseek-flash：峰时 2/8/0.04、谷时 1/4/0.02 元/百万 token。
  // 峰时范围按公开价口径 UTC 01-04、06-10 = 北京时间 09-12、14-18，仅工作日；其余全算谷时。
  'deepseek-account/*': {
    currency: 'CNY',
    periods: [
      { label: '峰时 09-12/14-18（工作日）', ranges: [[9, 12], [14, 18]], days: [1, 2, 3, 4, 5], rate: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } },
      { label: '谷时', ranges: [[0, 24]], rate: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 } },
    ],
  },
})

/**
 * 把任何输入收敛成合法的时区偏移（-12 ~ +14）；非法值按默认的北京时间返回。
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function normalizeOffsetHours(value, fallback = 8) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(-12, Math.min(14, Math.round(n * 4) / 4))
}

/** 时区偏移转成 ISO 后缀（+08:00），用来拼「某天某小时」的时间戳。 */
export function offsetZone(utcOffsetHours = 8) {
  const offset = normalizeOffsetHours(utcOffsetHours)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const hours = String(Math.floor(abs)).padStart(2, '0')
  const minutes = String(Math.round((abs - Math.floor(abs)) * 60)).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/** 「小时 / 星期 / 日期」按给定时区偏移切分，用于匹配峰谷时段。 */
export function beijingParts(timestamp, utcOffsetHours = 8) {
  const offset = normalizeOffsetHours(utcOffsetHours)
  const shifted = new Date(Number(timestamp) + offset * 3600 * 1000)
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
  const pick = (...keys) => {
    for (const key of keys) {
      const value = Number(source[key])
      if (Number.isFinite(value) && value > 0) return value
    }
    return 0
  }
  const inputTokens = pick('inputTokens', 'input_tokens')
  const outputTokens = pick('outputTokens', 'output_tokens')
  const totalTokens = pick('totalTokens', 'total_tokens')
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    cacheReadTokens: pick('cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens'),
    cacheWriteTokens: pick('cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens'),
    reasoningTokens: pick('reasoningTokens', 'reasoning_tokens'),
  }
}

/** 把毫秒时间戳格式化为北京时间 YYYY-MM-DD。 */
export function dayKey(timestamp = Date.now(), utcOffsetHours = 8) {
  return beijingParts(timestamp, utcOffsetHours).dayKey
}

/** 从某个时间点往前 days 天，返回北京时间 YYYY-MM-DD。 */
export function dayKeyBefore(days, timestamp = Date.now(), utcOffsetHours = 8) {
  return dayKey(Number(timestamp) - Math.max(0, days) * 24 * 3600 * 1000, utcOffsetHours)
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
export function rateAt(rule, at, promptTokens = 0, utcOffsetHours = 8) {
  if (!rule || rule.source === SOURCE_NONE) return { rate: ZERO_RATE, label: '', peak: false }
  // 官方价表可以声明自己的时区（DeepSeek 官方峰时按 UTC 定义）；
  // 其它规则继续跟随插件的 utcOffsetHours。
  const effectiveOffset = normalizeOffsetHours(rule.utcOffsetHours ?? utcOffsetHours)
  const { hour, weekday, dayKey: day } = beijingParts(at, effectiveOffset)
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
export function createPricer({ custom = {}, providers = {}, holidays = [], usdToCny = 7.1, utcOffsetHours = 8 } = {}) {
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
    // 人工导入可能正好补在别名上；精确 ID 优先于目录别名，避免被覆盖。
    const entry = table.models[model] ?? table.models[name]
    if (!entry) return null
    const currency = entry.currency ?? table.currency ?? 'CNY'
    const source =
      entry.origin === 'manual' || table.source === SOURCE_MANUAL
        ? SOURCE_MANUAL
        : entry.origin === SOURCE_CATALOG || table.source === SOURCE_CATALOG
          ? SOURCE_CATALOG
          : SOURCE_OFFICIAL
    return {
      source,
      currency: 'CNY',
      originalCurrency: currency,
      utcOffsetHours: entry.utcOffsetHours ?? table.utcOffsetHours,
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
      const value = DEFAULT_PRICING[key]
      // 内置表同样允许带峰谷时段（官方账号按 UTC 区分峰谷），否则按单档价处理。
      if (value && Array.isArray(value.periods)) {
        return {
          source: SOURCE_ESTIMATE,
          currency: value.currency ?? 'CNY',
          utcOffsetHours: value.utcOffsetHours,
          periods: value.periods.map((period) => ({
            label: period.label || '',
            ranges: period.ranges ?? [],
            days: period.days,
            rate: normalizeRate(period.rate),
          })),
          tiers: [],
          feedId: '',
          holidays,
        }
      }
      const rate = normalizeRate(value)
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
    const picked = rateAt(rule, at, promptTokens, utcOffsetHours)
    return { rule, ...picked }
  }

  /** 给 UI 用的价格说明（时段 + 单价）。 */
  function describe(provider, model) {
    const rule = resolve(provider, model)
    return {
      source: rule.source,
      currency: rule.currency,
      originalCurrency: rule.originalCurrency ?? rule.currency,
      utcOffsetHours: rule.utcOffsetHours,
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
