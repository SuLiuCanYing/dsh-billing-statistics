/**
 * DeepSeek 官方 API 的价格与峰谷信息。
 *
 * 这里只做三件事，且都限定在 DeepSeek 官方 provider：
 * 1. 识别 deepseek-official / deepseek-account（以及 baseURL 指向 api.deepseek.com 的 provider）；
 * 2. 内置一份官网价表作为离线兜底；
 * 3. 在人工导入弹窗打开前，从官方文档的 Markdown 源读取最新价（失败时退回内置表）。
 *
 * 官方峰时是 UTC 01:00-04:00、06:00-10:00，周一至周五；其余时段为谷时。
 * 价表本身保留美元，由计价器按配置的 usdToCny 折算成人民币，避免把汇率写死。
 */

import { formatPeakRanges, normalizeOffsetHours, peakDaysLabel } from './pricing.js'

/** 插件版本；与 package.json 的版本由测试保持一致。 */
export const PLUGIN_VERSION = '1.13.0'
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing.md'
export const OFFICIAL_PRICING_PAGE = 'https://api-docs.deepseek.com/quick_start/pricing'
export const OFFICIAL_PROVIDER_IDS = Object.freeze(['deepseek', 'deepseek-official', 'deepseek-account'])
export const OFFICIAL_HOST = 'api.deepseek.com'
export const OFFICIAL_PEAK_RANGES_UTC = Object.freeze([[1, 4], [6, 10]])
export const OFFICIAL_PEAK_DAYS = Object.freeze([1, 2, 3, 4, 5])

/** DeepSeek 官方价（美元 / 百万 token）。官网 2026-11 的公开价。 */
const OFFICIAL_MODELS = Object.freeze({
  'deepseek-flash': {
    name: 'DeepSeek-V4.1-Flash',
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek-V4-Pro',
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
  },
})

/** 官网明确说这些旧名字仍按 Flash 计费。 */
const OFFICIAL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

function copyRate(rate) {
  return {
    input: Number(rate?.input) || 0,
    output: Number(rate?.output) || 0,
    cacheRead: Number(rate?.cacheRead) || 0,
    cacheWrite: Number(rate?.cacheWrite) || 0,
  }
}

function copyModels(models) {
  const result = {}
  for (const [id, entry] of Object.entries(models ?? {})) {
    result[id] = {
      name: entry.name || id,
      peak: copyRate(entry.peak),
      offPeak: copyRate(entry.offPeak),
    }
  }
  return result
}

/** 内置价表（不联网也能用）。 */
export function builtinOfficialPricing() {
  return {
    models: copyModels(OFFICIAL_MODELS),
    plan: officialPlanUtc(),
    fetchedAt: 0,
    source: 'builtin',
    url: OFFICIAL_PRICING_PAGE,
    error: '',
  }
}

/** 官方峰时的 UTC 计划。 */
export function officialPlanUtc() {
  return {
    ranges: OFFICIAL_PEAK_RANGES_UTC.map((range) => [...range]),
    days: [...OFFICIAL_PEAK_DAYS],
    utc: true,
    label: `官方峰时 ${formatPeakRanges(OFFICIAL_PEAK_RANGES_UTC)} UTC（${peakDaysLabel([...OFFICIAL_PEAK_DAYS])}）`,
  }
}

/** 某个模型 id 对应的官方价；旧 id 会归到官网当前的模型。 */
export function officialModelEntry(model, data = builtinOfficialPricing()) {
  const id = String(model ?? '').trim().toLowerCase()
  if (!id) return null
  const canonical = OFFICIAL_ALIASES[id] ?? id
  const source = data?.models?.[canonical]
  if (!source) return null
  const entry = copyModels({ [canonical]: source })[canonical]
  return { id: canonical, requested: id, ...entry }
}

/**
 * 判断一个 provider 目录项是否是 DeepSeek 官方 API。
 * 只认明确的官方 route id，或 baseURL 的 host 是 api.deepseek.com；
 * 不按 displayName 猜，避免把“某平台上的 DeepSeek 模型”误判成官方。
 */
export function isDeepSeekOfficialProvider(entry) {
  const provider = String(entry?.provider ?? entry?.id ?? '').trim().toLowerCase()
  if (OFFICIAL_PROVIDER_IDS.includes(provider)) return true
  const rawUrl = [entry?.defaultBaseURL, entry?.baseURL, entry?.baseUrl]
    .find((value) => typeof value === 'string' && value.trim())
  if (typeof rawUrl !== 'string') return false
  try {
    const url = new URL(rawUrl.trim())
    return url.hostname.toLowerCase() === OFFICIAL_HOST
  } catch {
    return false
  }
}

/** 官方 provider 的所有已知模型 id（含兼容旧 id）。 */
export function officialModelIds(data = builtinOfficialPricing()) {
  const ids = Object.keys(data?.models ?? {})
  for (const [alias, canonical] of Object.entries(OFFICIAL_ALIASES)) {
    if (data?.models?.[canonical] && !ids.includes(alias)) ids.push(alias)
  }
  return ids
}

/** 给计价器用的模型表：保留 USD 与 UTC 峰谷，由 pricing.js 统一折算。 */
export function officialProviderModels(data = builtinOfficialPricing()) {
  const models = {}
  const plan = officialPlanUtc()
  for (const id of officialModelIds(data)) {
    const entry = officialModelEntry(id, data)
    if (!entry) continue
    models[id] = {
      currency: 'USD',
      origin: 'official',
      free: false,
      utcOffsetHours: 0,
      periods: [
        {
          label: plan.label,
          ranges: plan.ranges.map((range) => [...range]),
          days: [...plan.days],
          rate: entry.peak,
        },
        {
          label: '官方谷时',
          ranges: [[0, 24]],
          rate: entry.offPeak,
        },
      ],
    }
  }
  return models
}

/** 把官方价转成人工导入表格的行（基础价 = 谷时，峰时价 = 官方峰时）。 */
export function officialPriceRows(data = builtinOfficialPricing()) {
  const rows = {}
  for (const id of officialModelIds(data)) {
    const entry = officialModelEntry(id, data)
    if (!entry) continue
    rows[id] = {
      input: entry.offPeak.input,
      output: entry.offPeak.output,
      cacheRead: entry.offPeak.cacheRead,
      cacheWrite: entry.offPeak.cacheWrite,
      peakInput: entry.peak.input,
      peakOutput: entry.peak.output,
      peakCacheRead: entry.peak.cacheRead,
      peakCacheWrite: entry.peak.cacheWrite,
    }
  }
  return rows
}

/**
 * 弹窗里展示的峰时（把官方 UTC 窗口按当前时区位移）。
 * 官方计价本身用 UTC，不依赖这个展示值；这里只用于人工覆盖时的预填。
 */
export function officialPlanForOffset(utcOffsetHours = 8) {
  const offset = normalizeOffsetHours(utcOffsetHours)
  const ranges = []
  for (const [from, to] of OFFICIAL_PEAK_RANGES_UTC) {
    let start = from + offset
    let end = to + offset
    while (start < 0) {
      start += 24
      end += 24
    }
    while (start >= 24) {
      start -= 24
      end -= 24
    }
    if (end <= 24) ranges.push([start, end])
    else {
      ranges.push([start, 24])
      ranges.push([0, end - 24])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  return {
    ranges,
    days: [...OFFICIAL_PEAK_DAYS],
    utc: false,
    label: `官方峰时 ${formatPeakRanges(ranges)}（${peakDaysLabel([...OFFICIAL_PEAK_DAYS])}，UTC ${offset >= 0 ? '+' : ''}${offset}）`,
  }
}

/** Markdown 表格的单元格清理。 */
function cleanCell(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableCells(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cleanCell)
}

function moneyValues(cells) {
  const values = []
  for (const cell of cells) {
    const match = /^\$\s*([0-9]+(?:\.[0-9]+)?)$/.exec(cell)
    if (match) values.push(Number(match[1]))
  }
  return values
}

/**
 * 解析官网 pricing.md 的价表。只接受能完整读出模型、峰/谷、三档价格的表；
 * 结构变化时抛错，由调用方退回内置表，绝不猜一个价格。
 */
export function parseOfficialMarkdown(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  let modelNames = []
  let headerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('|')) continue
    const cells = tableCells(lines[index])
    if (!cells.some((cell) => /^MODEL$/i.test(cell))) continue
    const found = cells
      .filter((cell) => /^deepseek-[a-z0-9-]+/i.test(cell))
      .map((cell) => cell.split(/\s+/)[0].replace(/\([^)]*\)/g, '').toLowerCase())
    if (found.length > 0) {
      modelNames = [...new Set(found)]
      headerIndex = index
      break
    }
  }
  if (headerIndex < 0 || modelNames.length === 0) throw new Error('官网价表里没有找到模型列')

  const result = {}
  for (const id of modelNames) {
    result[id] = { name: id, peak: null, offPeak: null }
  }
  let category = ''
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('|')) {
      if (Object.keys(result).length > 0 && lines[index].trim() && !lines[index].includes('|')) break
      continue
    }
    const cells = tableCells(lines[index])
    const joined = cells.join(' ').toLowerCase()
    if (joined.includes('cache hit')) category = 'cacheRead'
    else if (joined.includes('cache miss')) category = 'input'
    else if (joined.includes('output tokens')) category = 'output'
    else if (!joined.includes('off-peak') && !joined.includes('peak')) continue
    if (!category) continue
    const level = /\boff-peak\b/i.test(joined) ? 'offPeak' : /\bpeak\b/i.test(joined) ? 'peak' : ''
    if (!level) continue
    const prices = moneyValues(cells)
    if (prices.length !== modelNames.length) continue
    modelNames.forEach((id, modelIndex) => {
      result[id][level] = result[id][level] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      result[id][level][category] = prices[modelIndex]
    })
  }

  for (const id of modelNames) {
    const entry = result[id]
    if (!entry.peak || !entry.offPeak) throw new Error(`官网价表缺少 ${id} 的峰/谷价格`)
    for (const key of ['input', 'output', 'cacheRead']) {
      if (!Number.isFinite(entry.peak[key]) || !Number.isFinite(entry.offPeak[key])) {
        throw new Error(`官网价表缺少 ${id} 的 ${key} 价格`)
      }
    }
  }

  return {
    models: copyModels(result),
    plan: officialPlanUtc(),
    fetchedAt: Date.now(),
    source: 'live',
    url: OFFICIAL_PRICING_PAGE,
    error: '',
  }
}

/** 从官网 Markdown 源读取最新价；网络/格式失败时抛错，由 getOfficialPricing 兜底。 */
export async function fetchOfficialPricing({ timeoutMs = 12000 } = {}) {
  const response = await fetch(OFFICIAL_PRICING_URL, {
    headers: {
      accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
      'user-agent': `dsh-billing-statistics/${PLUGIN_VERSION}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`DeepSeek 官网 HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 200_000) throw new Error('DeepSeek 官网响应过大')
  return parseOfficialMarkdown(text)
}

let officialCache = null
let officialPending = null

/** 清空内存缓存，测试用。 */
export function resetOfficialCacheForTests() {
  officialCache = null
  officialPending = null
}

/**
 * 读官方价：优先 1 小时内存缓存；失败时用上次成功结果，再退回内置表。
 * 绝不抛错，保证弹窗和计价不会被网络问题拖垮。
 */
export async function getOfficialPricing({ force = false, now = Date.now(), ttlMs = 60 * 60 * 1000 } = {}) {
  if (!force && officialCache?.data && now - officialCache.at < ttlMs) return officialCache.data
  if (officialPending) return officialPending
  officialPending = (async () => {
    try {
      const data = await fetchOfficialPricing()
      officialCache = { at: now, data }
      return data
    } catch (error) {
      const message = String(error?.message ?? error)
      if (officialCache?.data) {
        return { ...officialCache.data, source: 'cache', error: message }
      }
      return { ...builtinOfficialPricing(), error: message }
    } finally {
      officialPending = null
    }
  })()
  return officialPending
}
