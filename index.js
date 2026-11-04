/**
 * dsh-billing-statistics —— Host 半边。
 *
 * 采集：挂在 `llm/stream` 瀑布上包裹每一次模型请求尝试，从流里读 provider、
 *       model、usage 与 finish，写入按「平台 × 模型 × 小时」聚合的计数器。
 * 价格：从 models.dev 的结构化模型目录里按平台 / 模型检索；目录带缓存在本地，
 *       在线失败时用随插件发布的快照兜底；配置的 pricing / 人工导入价格优先级更高。
 *       自动同步每天一次，错过的时间段在下次启动时刷新。
 * 持久化：`$DSH_HOME/llm-usage-insights/usage.json`（历史兼容目录）、`prices.json`、`manual-prices.json`、`models-dev.json`（原子写）。
 * 接口：summary / model / reset / prices / prices/official / prices/sync / prices/import / export.html / export.pdf（另保留 export.csv 兼容）。
 */

import { loadSchema } from './schema.js'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { UsageStore } from './usage-store.js'
import { SOURCE_NONE, beijingParts, createPricer, mergeManualPriceModels, normalizeManualPeak, normalizeManualPriceModels, normalizeOffsetHours, normalizeUsage, retimeManualPriceModels } from './pricing.js'
import { buildCsv } from './export-csv.js'
import { buildReport } from './export-report.js'
import { buildPdf } from './export-pdf.js'
import {
  OFFICIAL_PRICING_PAGE,
  builtinOfficialPricing,
  getOfficialPricing,
  isDeepSeekOfficialProvider,
  officialModelIds,
  officialPlanForOffset,
  officialPriceRows,
  officialProviderModels,
} from './deepseek-official.js'
import {
  CATALOG_SOURCE,
  catalogPriceEntry,
  loadCatalog,
  lookupCatalogModel,
  refreshCatalog,
} from './model-catalog.js'

/** 路由前缀；页面就按这个路径取数。 */
export const API_PREFIX = '/api/llm-usage/v1'
const SUMMARY_PATH = `${API_PREFIX}/summary`
const RESET_PATH = `${API_PREFIX}/reset`
const PRICES_PATH = `${API_PREFIX}/prices`
const PRICES_SYNC_PATH = `${API_PREFIX}/prices/sync`
const PRICES_IMPORT_PATH = `${API_PREFIX}/prices/import`
const PRICES_OFFICIAL_PATH = `${API_PREFIX}/prices/official`
const EXPORT_REPORT_PATH = `${API_PREFIX}/export.html`
const EXPORT_CSV_PATH = `${API_PREFIX}/export.csv`
const EXPORT_PDF_PATH = `${API_PREFIX}/export.pdf`
const MODEL_PATH = `${API_PREFIX}/model`
const RECONCILE_PATH = `${API_PREFIX}/reconcile`

/** 对外注册的全部精确路由；单独导出便于测试防止“写了 handler 却忘了注册”。 */
export const ROUTES = Object.freeze([
  SUMMARY_PATH,
  EXPORT_REPORT_PATH,
  EXPORT_PDF_PATH,
  EXPORT_CSV_PATH,
  RESET_PATH,
  MODEL_PATH,
  RECONCILE_PATH,
  PRICES_PATH,
  PRICES_OFFICIAL_PATH,
  PRICES_SYNC_PATH,
  PRICES_IMPORT_PATH,
])

const schemaLoad = await loadSchema()
const Schema = schemaLoad.Schema

function buildConfig(Schema) {
  const rateSchema = Schema.object({
    input: Schema.number().min(0).default(0).description('输入（未命中缓存）元 / 百万 token。Input tokens (cache miss), CNY per 1M tokens.'),
    output: Schema.number().min(0).default(0).description('输出元 / 百万 token。Output tokens, CNY per 1M tokens.'),
    cacheRead: Schema.number().min(0).default(0).description('缓存命中读取 元 / 百万 token。Cache-hit reads, CNY per 1M tokens.'),
    cacheWrite: Schema.number().min(0).default(0).description('缓存写入 元 / 百万 token。Cache writes, CNY per 1M tokens.'),
  })

  return Schema.object({
    retainDays: Schema.number()
      .min(1)
      .max(3660)
      .default(30)
      .description('按天明细的保留天数（默认一个月）；更早的分桶在下次启动时清理。 Days of per-day detail kept; older buckets are pruned on next start.'),
    showCost: Schema.boolean().default(true).description('页面上是否显示花费列与花费合计。 Whether the cost column and totals are shown in the panel.'),
    priceSync: Schema.boolean()
      .default(true)
      .description('每天自动刷新一次 models.dev 价格目录；当天没开程序的话，下次启动时补刷一次。 Refresh the models.dev catalog once a day; catch up on next start.'),
    usdToCny: Schema.number()
      .min(0.1)
      .max(100)
      .default(7.1)
      .description('models.dev 与 DeepSeek 官方价都是美元 / 百万 token；按这个汇率折成人民币计入花费。 models.dev and DeepSeek official prices are USD per 1M tokens; this rate converts them to CNY.'),
    peakHolidays: Schema.array(Schema.string())
      .default([])
      .description(
        '视为「空闲时段」的日期（YYYY-MM-DD，按 utcOffsetHours 解释），用于 DeepSeek 这类工作日峰谷价。 Dates (YYYY-MM-DD, interpreted with utcOffsetHours) treated as off-peak, e.g. Chinese public holidays. ' +
          '中国法定节假日可填在这里，避免节假日按高峰价估算。',
      ),
    utcOffsetHours: Schema.number()
      .min(-12)
      .max(14)
      .default(8)
      .description(
        '峰谷时段与「按天」分桶使用的时区偏移（小时），默认 8 即北京时间。 Timezone offset in hours used for peak windows and daily buckets; 8 = UTC+8 (Beijing). ' +
          '填 0 表示 UTC，填 9 表示东京；数据文件里已有的分桶不会重排。 Existing buckets are not re-keyed when this changes. ' +
          'DeepSeek 官方价按 UTC 峰时计价，页面按这个偏移显示本地时段。',
      ),
    pricing: Schema.dict(rateSchema)
      .default({})
      .description(
        '每百万 token 的价格表，键可以是 provider、provider/model（模型 id 里的斜杠不影响匹配）或 *。 Price table per 1M tokens; keys may be provider, provider/model, or *. ' +
          '写了同名键会整体覆盖 models.dev / DeepSeek 官方 / 内置价格；全 0 视为未定价。 A matching key overrides models.dev/official/built-in prices; all zeros mean unpriced.',
      ),
  })
}

export const Config = Schema ? buildConfig(Schema) : undefined

export const inject = ['llm', 'webServer']

/** 数据目录：$DSH_HOME/llm-usage-insights（历史兼容路径，避免更名丢账）。 */
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'llm-usage-insights')
}

/** llm 目录里的平台展示名；目录不可用时返回空数组。 */
function providerDirectory(ctx) {
  try {
    const entries = ctx.llm?.listConfigurableProviders?.()
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry) => {
        // 目录项当前是对象；将来若退化成字符串，至少不要把平台整个丢掉。
        if (typeof entry === 'string') {
          const provider = entry.trim()
          return provider ? { provider } : null
        }
        if (!entry || typeof entry !== 'object') return null
        const provider = typeof entry.provider === 'string' ? entry.provider : ''
        if (!provider) return null
        return {
          provider,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
          defaultBaseURL: typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : undefined,
          baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : undefined,
        }
      })
      .filter(Boolean)
  } catch (error) {
    ctx.logger?.debug?.(`dsh-billing-statistics: 读取 provider 目录失败：${String(error?.message ?? error)}`)
    return []
  }
}

/** 流里的 usage 块归一化。字段缺失时按 0。 */
function readUsage(chunk) {
  // 当前契约是独立的 usage chunk；兼容将来把 usage 挂到 finish/任意 chunk 上的形态。
  const usage = chunk?.usage ?? chunk?.finish?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  return usage
}

/** 成功结束却没有有效 token 时，说明 usage 契约可能变了；每个平台×模型每分钟最多提醒一次。 */
const warnedMissingUsage = new Map()

function hasTokenUsage(usage) {
  const tokens = normalizeUsage(usage)
  return (
    tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.reasoningTokens >
    0
  )
}

function warnMissingUsage(store, provider, model) {
  const key = `${provider}\u0000${model}`
  const now = Date.now()
  if (now - (warnedMissingUsage.get(key) ?? 0) < 60_000) return
  warnedMissingUsage.set(key, now)
  store.logger?.warn?.(
    `dsh-billing-statistics: ${provider}/${model} 成功结束但没有有效 usage，token 与花费会按 0 记录；请检查宿主 llm/stream 的 usage 契约。`,
  )
}

/**
 * 把一次请求尝试包进生成器：透传所有 chunk，在流结束时记账。
 * 记账放在 try/finally（含消费者提前 break / return），保证每个尝试只记一次。
 */
function captureAttempt(store, options, next) {
  const provider = String(options?.provider ?? 'unknown')
  const model = String(options?.model ?? 'unknown')
  return {
    async *[Symbol.asyncIterator]() {
      let usage = null
      let outcome = 'ok'
      let sawTerminal = false
      try {
        const source = next()
        for await (const chunk of source) {
          const type = typeof chunk?.type === 'string' ? chunk.type.toLowerCase() : ''
          // usage 可能出现在任意位置（一般是 finish 之前），始终记录。
          const nextUsage = readUsage(chunk)
          if (nextUsage) usage = nextUsage
          if (!sawTerminal && type === 'finish') {
            sawTerminal = true
            const reason = chunk.reason ?? chunk.finishReason
            const kind =
              typeof reason === 'string'
                ? reason.toLowerCase()
                : String(reason?.kind ?? reason?.type ?? '').toLowerCase()
            if (kind === 'error') outcome = 'failed'
            else if (kind === 'aborted') outcome = 'aborted'
          } else if (type === 'error') {
            outcome = 'failed'
          }
          yield chunk
        }
      } catch (error) {
        outcome = 'failed'
        throw error
      } finally {
        try {
          // 历史数据尚未读完时不能记这一笔，否则 load() 会用盘上旧记录把它覆盖掉。
          await store.whenReady?.()
          if (outcome === 'ok' && !hasTokenUsage(usage)) warnMissingUsage(store, provider, model)
          store.recordCall({ provider, model, outcome, usage: usage ?? undefined })
        } catch (error) {
          // 记账绝不能影响模型调用本身。
          store.logger?.warn?.(`dsh-billing-statistics: 记账失败：${String(error?.message ?? error)}`)
        }
      }
    },
  }
}

/** 同一来源校验：Host 必须是本机，Origin 必须与 Host 同源。 */
function sameOrigin(request) {
  const host = String(request.headers?.host ?? '')
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback =
    hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' || hostname === '[::1]'
  if (!loopback) return false
  const origin = request.headers?.origin
  if (!origin) return true
  try {
    const url = new URL(String(origin))
    return url.host === host
  } catch {
    return false
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** 请求准入：优先用 connection 的 Host/Origin + 浏览器认证校验，旧宿主退回同源判断。 */
function admitted(ctx, request) {
  const connection = ctx.get?.('connection')
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(request)
      // 当前契约是同步返回 undefined（允许）或状态码（拒绝）。若将来改成 Promise，
      // 不能把 Promise 当成“已拒绝”而让整页 403；退回仅本机同源的保守判断。
      if (rejection && typeof rejection.then === 'function') {
        ctx.logger?.warn?.('dsh-billing-statistics: connection.requestRejection 返回了 Promise，退回本机同源校验。')
        return sameOrigin(request)
      }
      return rejection === undefined
    } catch (error) {
      // 契约变化或临时异常时，至少不要让本机页面完全取不到数。
      ctx.logger?.warn?.(
        `dsh-billing-statistics: connection.requestRejection 异常，退回本机同源校验：${String(error?.message ?? error)}`,
      )
      return sameOrigin(request)
    }
  }
  return sameOrigin(request)
}

function parseDays(request) {
  try {
    const url = new URL(String(request.url ?? '/'), 'http://localhost')
    const raw = Number(url.searchParams.get('days') ?? 7)
    if (!Number.isFinite(raw)) return 7
    // 0（或负数）表示「全部」：不设起点。
    if (raw <= 0) return 0
    return Math.min(3660, Math.floor(raw))
  } catch {
    return 7
  }
}

/** 单个日期参数：严格 YYYY-MM-DD，非法返回空串。 */
function parseDay(value) {
  const day = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const date = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return ''
  return day
}

/** 年份视图参数：0 表示未指定，合法范围 1970–2100。 */
function parseYear(request) {
  try {
    const url = new URL(String(request.url ?? '/'), 'http://localhost')
    const raw = Number(url.searchParams.get('year'))
    if (!Number.isInteger(raw) || raw < 1970 || raw > 2100) return 0
    return raw
  } catch {
    return 0
  }
}

/** 是否包含时间明细；默认包含，显式 detail=0 时只导出汇总。 */
function parseDetail(request) {
  try {
    const url = new URL(String(request.url ?? '/'), 'http://localhost')
    return url.searchParams.get('detail') !== '0'
  } catch {
    return true
  }
}

/** 收集导出需要的逐模型时间明细；detail=false 时调用方可跳过。 */
function collectDetails(store, summary) {
  const details = new Map()
  for (const platform of summary.platforms) {
    for (const model of platform.models) {
      details.set(
        `${platform.provider}/${model.model}`,
        store.modelDetail({
          provider: platform.provider,
          model: model.model,
          days: summary.kind === 'day' ? summary.days : 0,
          year: summary.kind === 'month' ? summary.year : 0,
        }),
      )
    }
  }
  return details
}

/** 导出共用的汇总 + 明细；detail=0 时不收集明细。 */
function exportPayload(store, request) {
  const summary = store.summary({ days: parseDays(request), year: parseYear(request) })
  const detail = parseDetail(request)
  return { summary, detail, details: detail ? collectDetails(store, summary) : new Map() }
}

/** 读一个小 JSON 请求体；超限或解析失败返回 null。 */
function readJsonBody(request, limit = 8192) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
        resolve(JSON.parse(text || '{}'))
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

/* ── 价格表：读写与同步 ───────────────────────────────────── */

async function readJsonFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeJsonFile(file, payload) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify(payload), 'utf8')
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** 数据时区偏移；自动同步按这个粒度判断「今天抓过没有」。 */
function utcOffset(config) {
  return normalizeOffsetHours(config?.utcOffsetHours)
}

function todayKey(config) {
  return beijingParts(Date.now(), utcOffset(config)).dayKey
}

/** 把 models.dev 目录里的价格命中整理成页面用的来源信息。 */
function catalogMeta(entry) {
  if (!entry) return null
  return {
    provider: entry.catalogProvider ?? '',
    providerName: entry.catalogProviderName ?? '',
    model: entry.catalogModel ?? '',
    matchKind: entry.matchKind ?? 'provider',
    reference: entry.matchKind === 'reference',
  }
}

/** 人工价里的基础价（全天时段优先）。 */
function manualBaseRate(entry) {
  const periods = Array.isArray(entry?.periods) ? entry.periods : []
  const full = periods.find((period) => (period.ranges ?? []).some(([from, to]) => from === 0 && to === 24))
  return full?.rate ?? entry?.defaultRate ?? periods[periods.length - 1]?.rate ?? {}
}

/** 人工价里的峰时价。 */
function manualPeakRate(entry) {
  const periods = Array.isArray(entry?.periods) ? entry.periods : []
  const peak = periods.find(
    (period) =>
      String(period.label ?? '').startsWith('峰时') ||
      (period.ranges ?? []).some(([from, to]) => !(from === 0 && to === 24)),
  )
  return peak?.rate ?? {}
}

/** 把人工导入价整理成「模型 → 单价」，供导入弹窗回填。 */
function manualPriceRows(own) {
  const rows = {}
  for (const [model, entry] of Object.entries(own?.models ?? {})) {
    const rate = manualBaseRate(entry)
    const peak = manualPeakRate(entry)
    rows[model] = {
      input: Number(rate.input) || 0,
      output: Number(rate.output) || 0,
      cacheRead: Number(rate.cacheRead ?? rate.cache_read) || 0,
      cacheWrite: Number(rate.cacheWrite ?? rate.cache_write) || 0,
      peakInput: Number(peak.input) || 0,
      peakOutput: Number(peak.output) || 0,
      peakCacheRead: Number(peak.cacheRead ?? peak.cache_read) || 0,
      peakCacheWrite: Number(peak.cacheWrite ?? peak.cache_write) || 0,
    }
  }
  return rows
}

/** 某平台是否按 DeepSeek 官方 API 处理（明确 id 或已登记的官方 provider）。 */
export function isOfficialPricingProvider(provider, officialProviders) {
  return Boolean(officialProviders?.has?.(provider)) || isDeepSeekOfficialProvider({ provider })
}

/**
 * 人工价是否应参与计价。
 * 官方平台默认用官方自动价；只有用户在导入弹窗里显式保存过，旧人工价才转为覆盖。
 */
export function manualPriceIsActive(provider, own, officialProviders) {
  if (!own) return false
  return !isOfficialPricingProvider(provider, officialProviders) || own.officialOverride === true
}

/** 汇总当前价格状态（models.dev 命中、人工导入、官方自动价、同步时间）。 */
export function priceReport({ snapshot, config, providers, names, manual, official, officialProviders, activeModels }) {
  const cached = snapshot?.providers ?? {}
  const imported = manual?.providers ?? {}
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : []
  const entries = providers.map((provider) => {
    const page = cached[provider]
    const own = imported[provider]
    const catalog = catalogMeta(page)
    const pageModels = page?.models ? Object.keys(page.models) : []
    const importedModels = own?.models ? Object.keys(own.models) : []
    const isOfficial = isOfficialPricingProvider(provider, officialProviders)
    const officialModels = isOfficial ? officialModelIds(official) : []
    const modelCount = new Set([...pageModels, ...importedModels, ...officialModels]).size
    const active = Array.isArray(activeModels?.[provider]) ? activeModels[provider] : []
    const manualOverride = Boolean(isOfficial && own?.officialOverride === true)
    const manualActive = manualPriceIsActive(provider, own, officialProviders)
    const manualSet = new Set(manualActive ? importedModels : [])
    const officialSet = new Set(officialModels)
    const officialActive = active.filter((model) => officialSet.has(model))
    // 人工价 / 官方价才算「这个平台自己的可靠价」；models.dev 目录价与跨平台参考价
    // 都没有平台峰时窗口，仍需在价格条里提示人工确认。
    const covered = (model) => manualSet.has(model) || officialSet.has(model)
    const usingDefault = active.length > 0
      ? active.some((model) => !covered(model))
      : pageModels.some((model) => !covered(model))
    return {
      provider,
      title: names?.[provider] || provider,
      origin: manualActive ? 'manual' : isOfficial ? 'official' : catalog ? 'catalog' : '',
      ok: manualActive || isOfficial || Boolean(page?.ok),
      missing: manualActive || isOfficial ? false : !page?.ok,
      error: page?.error ?? '',
      catalogProvider: catalog?.provider ?? '',
      catalogProviderName: catalog?.providerName ?? '',
      catalogModel: catalog?.model ?? '',
      matchKind: catalog?.matchKind ?? '',
      reference: Boolean(catalog?.reference),
      currency: manualActive ? own?.currency : isOfficial ? 'USD' : page?.currency ?? 'CNY',
      models: modelCount,
      manualModels: manualActive ? importedModels.length : 0,
      manualPrices: own ? manualPriceRows(own) : {},
      peak: manualActive ? own?.peak : isOfficial ? official?.plan ?? null : null,
      fetchedAt: manualActive
        ? Number(own?.updatedAt) || 0
        : isOfficial
          ? Number(official?.fetchedAt) || 0
          : Number(page?.fetchedAt) || 0,
      manual: manualActive,
      manualSaved: Boolean(own),
      manualOverride,
      official: isOfficial,
      officialSource: isOfficial ? official?.source ?? 'builtin' : '',
      officialFetchedAt: isOfficial ? Number(official?.fetchedAt) || 0 : 0,
      officialModels: isOfficial ? officialActive.length || officialModels.length : 0,
      officialModelList: officialModels,
      activeModels: active,
      usingDefault,
    }
  })
  const day = typeof snapshot?.day === 'string' ? snapshot.day : ''
  return {
    enabled: config?.priceSync !== false,
    source: CATALOG_SOURCE,
    fetchedAt: Number(snapshot?.catalogFetchedAt) || 0,
    catalogSource: snapshot?.catalogSource ?? '',
    catalogError: snapshot?.catalogError ?? '',
    day,
    today: todayKey(config),
    syncedToday: day === todayKey(config),
    stale: day !== todayKey(config),
    providers: entries,
    errors,
  }
}

/**
 * 同步 models.dev 价格：按平台 / 模型检索 → 写 prices.json → 重建计价器。
 * @param {{ ctx: any, config: any, file: string, catalogFile: string, store: UsageStore, state: any }} input
 */
function createPriceSync({ ctx, config, file, catalogFile, store, state }) {
  let running = null

  const refresh = async () => {
    const result = await refreshCatalog({ cacheFile: catalogFile, logger: ctx.logger })
    state.catalog = result.catalog
    state.catalogSource = result.source
    state.catalogError = result.error
    if (result.error) {
      ctx.logger?.warn?.(`dsh-billing-statistics: models.dev 在线刷新失败，使用 ${result.source}：${result.error}`)
    }
    return result
  }

  const run = async ({ only = null, forceRefresh = false } = {}) => {
    const names = store.platformNames()
    const modelsByProvider = store.providerModels()
    // 只处理真正用过的平台与有手工价的平台。
    const active = new Set([
      ...Object.keys(modelsByProvider),
      ...Object.keys(state.manual?.providers ?? {}),
    ])
    state.providers = [...active]

    // 刷新按钮 / 每天首次同步都重新拉 models.dev；普通补抓复用内存目录。
    if (forceRefresh || !state.catalog) await refresh()

    const previous = state.snapshot?.providers ?? {}
    const table = { ...previous }
    const errors = []
    let okNow = 0

    for (const provider of active) {
      if (only && !only.includes(provider)) continue
      const modelIds = modelsByProvider[provider] ?? []
      if (modelIds.length === 0) continue

      const matched = {}
      const missed = []
      let first = null
      let hasReference = false
      for (const modelId of modelIds) {
        const hit = lookupCatalogModel(state.catalog, {
          provider,
          displayName: names[provider] ?? '',
          model: modelId,
        })
        if (!hit) {
          missed.push(modelId)
          continue
        }
        if (!first) first = hit
        if (hit.matchKind === 'reference') hasReference = true
        matched[modelId] = catalogPriceEntry(hit, state.catalog?.fetchedAt ?? Date.now())
      }

      if (Object.keys(matched).length === 0) {
        const message = `models.dev 未匹配到模型：${missed.slice(0, 4).join(', ')}`
        errors.push({ provider, title: names[provider] || provider, message })
        table[provider] = {
          ...(previous[provider] ?? {}),
          provider,
          origin: 'catalog',
          ok: false,
          missing: true,
          error: message,
          models: {},
          currency: 'USD',
          fetchedAt: state.catalog?.fetchedAt ?? 0,
        }
        continue
      }

      okNow += 1
      table[provider] = {
        provider,
        origin: 'catalog',
        catalogProvider: first?.provider ?? '',
        catalogProviderName: first?.providerName ?? '',
        catalogModel: first?.id ?? '',
        matchKind: hasReference ? 'reference' : 'provider',
        currency: 'USD',
        fetchedAt: state.catalog?.fetchedAt ?? Date.now(),
        ok: true,
        missing: false,
        error: missed.length > 0 ? `未匹配：${missed.slice(0, 4).join(', ')}` : '',
        models: matched,
        aliases: {},
      }
      if (missed.length > 0) {
        errors.push({
          provider,
          title: names[provider] || provider,
          message: `部分模型未匹配：${missed.slice(0, 4).join(', ')}`,
        })
      }
    }

    const anyOk = okNow > 0
    const snapshot = {
      version: 3,
      fetchedAt: Date.now(),
      day: anyOk ? todayKey(config) : (state.snapshot?.day ?? ''),
      catalogFetchedAt: Number(state.catalog?.fetchedAt) || 0,
      catalogSource: state.catalogSource ?? '',
      catalogError: state.catalogError ?? '',
      providers: table,
      errors: errors.slice(0, 12),
    }
    state.snapshot = snapshot
    try {
      await writeJsonFile(file, snapshot)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-billing-statistics: 写入价格表失败：${String(error?.message ?? error)}`)
    }
    rebuildPricer({ config, state, store })
    return priceReport({
      snapshot,
      config,
      providers: state.providers,
      names,
      manual: state.manual,
      official: state.official,
      officialProviders: state.officialProviders,
      activeModels: store.providerModels(),
    })
  }

  const sync = async (options) => {
    if (running) return running
    running = run(options).finally(() => {
      running = null
    })
    return running
  }
  sync.refresh = refresh
  return sync
}

/** 用当前价格快照重建计价器，并让 store 重算历史花费。 */
function rebuildPricer({ config, state, store }) {
  const providers = {}
  for (const [provider, page] of Object.entries(state.snapshot?.providers ?? {})) {
    if (!page?.models || Object.keys(page.models).length === 0) continue
    providers[provider] = {
      models: page.models,
      currency: page.currency ?? 'USD',
      aliases: page.aliases ?? {},
      url: '',
      feedId: page.catalogProvider ?? '',
      source: 'catalog',
    }
  }
  // DeepSeek 官方 API：官方价优先于 models.dev / 跨平台参考价，仅次于人工导入。
  // 官方价只写进“官方 provider”的表里，绝不扩到 siliconflow 等第三方平台。
  const officialProviders = new Set(state.officialProviders ?? [])
  for (const provider of [...Object.keys(providers), ...Object.keys(state.manual?.providers ?? {})]) {
    if (isDeepSeekOfficialProvider({ provider })) officialProviders.add(provider)
  }
  const officialModels = officialProviderModels(state.official)
  for (const provider of officialProviders) {
    const base = providers[provider] ?? { models: {}, currency: 'USD' }
    providers[provider] = {
      ...base,
      models: { ...(base.models ?? {}), ...officialModels },
      currency: 'USD',
      source: 'official',
      feedId: '',
      url: OFFICIAL_PRICING_PAGE,
      official: true,
    }
  }
  // 人工导入的价格单独持久化，models.dev 同步不会覆盖；同名模型默认以人工导入为准。
  // DeepSeek 官方 API 例外：旧版遗留的人工价默认收起，只有用户显式保存覆盖才生效。
  for (const [provider, own] of Object.entries(state.manual?.providers ?? {})) {
    if (!own?.models || Object.keys(own.models).length === 0) continue
    const manualProviderIsOfficial = isOfficialPricingProvider(provider, officialProviders)
    if (manualProviderIsOfficial && own.officialOverride !== true) continue
    providers[provider] = {
      ...(providers[provider] ?? {}),
      models: { ...(providers[provider]?.models ?? {}), ...own.models },
      currency: own.currency ?? 'CNY',
      aliases: providers[provider]?.aliases ?? {},
      url: '',
      feedId: 'manual',
      source: providers[provider]?.source ?? 'catalog',
    }
  }
  const pricer = createPricer({
    custom: config?.pricing ?? {},
    providers,
    holidays: Array.isArray(config?.peakHolidays) ? config.peakHolidays : [],
    usdToCny: Number(config?.usdToCny) || 7.1,
    utcOffsetHours: utcOffset(config),
  })
  store.setPricer(pricer)
  return pricer
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  if (!Schema) {
    ctx.logger?.warn?.(
      `dsh-billing-statistics: schemastery 不可用或 API 不兼容，已省略 Config schema；插件继续按现有配置运行：${String(schemaLoad.error?.message ?? schemaLoad.error)}`,
    )
  }
  const directory = dataDirectory()
  const priceFile = join(directory, 'prices.json')
  const manualFile = join(directory, 'manual-prices.json')
  const catalogFile = join(directory, 'models-dev.json')
  /** 共享的可变状态：models.dev 目录、价格快照、人工导入、provider 列表。 */
  const state = {
    snapshot: null,
    catalog: null,
    catalogSource: '',
    catalogError: '',
    manual: { version: 1, providers: {} },
    providers: [],
    official: builtinOfficialPricing(),
    officialProviders: new Set(),
    officialError: '',
  }
  // 启动时人工价文件是异步读取的；接口先等它加载完，避免刚打开页面就导入时
  // 旧文件又把新导入覆盖掉。
  let resolveManualReady
  const manualReady = new Promise((resolve) => {
    resolveManualReady = resolve
  })

  const providerEntries = providerDirectory(ctx)
  for (const entry of providerEntries) {
    if (entry?.provider && isDeepSeekOfficialProvider(entry)) state.officialProviders.add(entry.provider)
  }

  const store = new UsageStore({
    directory,
    retainDays: config?.retainDays ?? 30,
    utcOffsetHours: utcOffset(config),
    pricer: createPricer({
      custom: config?.pricing ?? {},
      holidays: config?.peakHolidays ?? [],
      utcOffsetHours: utcOffset(config),
    }),
    listProviders: () => providerDirectory(ctx),
    showCost: config?.showCost !== false,
    logger: ctx.logger,
  })
  // 尽早开始读盘；流钩子会在记账前等待它，避免启动瞬间的调用被 load() 覆盖。
  const storeReady = store.load()

  const syncPrices = createPriceSync({ ctx, config, file: priceFile, catalogFile, store, state })

  /**
   * 读取 DeepSeek 官方价。失败时 getOfficialPricing 会退回缓存/内置表，
   * 因此这里永远不会因为官网打不开而让接口 500；错误只作为提示返回页面。
   */
  const refreshOfficialPricing = async ({ force = false } = {}) => {
    const data = await getOfficialPricing({ force })
    state.official = data
    state.officialError = data.error ?? ''
    rebuildPricer({ config, state, store })
    return data
  }

  const officialPayload = (provider = '') => ({
    ok: true,
    provider,
    currency: 'USD',
    source: state.official?.source ?? 'builtin',
    fetchedAt: state.official?.fetchedAt ?? 0,
    error: state.officialError ?? '',
    url: state.official?.url ?? OFFICIAL_PRICING_PAGE,
    models: officialModelIds(state.official),
    rows: officialPriceRows(state.official),
    plan: officialPlanForOffset(utcOffset(config)),
  })

  /** 保存人工导入价格；只覆盖填写的模型，未填写的旧人工价保留。 */
  const importManualPrices = async (provider, models, currency = 'CNY', rawPeak = null, officialOverride = false) => {
    await manualReady
    const peak = normalizeManualPeak(rawPeak)
    const normalized = normalizeManualPriceModels(models, { currency, peak })
    const previous = retimeManualPriceModels(state.manual?.providers?.[provider]?.models ?? {}, peak)
    const isOfficial = isOfficialPricingProvider(provider, state.officialProviders)
    if (isOfficial) state.officialProviders.add(provider)
    const next = {
      ...(state.manual?.providers ?? {}),
      [provider]: {
        provider,
        currency: currency === 'USD' ? 'USD' : 'CNY',
        peak,
        models: mergeManualPriceModels(previous, normalized),
        updatedAt: Date.now(),
        // 只有用户显式保存过，才允许人工价覆盖 DeepSeek 官方自动价；
        // 旧版遗留的人工价默认收起，避免官方 API 仍显示“人工导入”。
        officialOverride: Boolean(isOfficial && officialOverride),
      },
    }
    state.manual = { version: 1, providers: next }
    await writeJsonFile(manualFile, state.manual)
    if (!state.providers.includes(provider)) state.providers.push(provider)
    rebuildPricer({ config, state, store })
    return priceReport({
      snapshot: state.snapshot,
      config,
      providers: state.providers,
      names: store.platformNames(),
      manual: state.manual,
      official: state.official,
      officialProviders: state.officialProviders,
      activeModels: store.providerModels(),
    })
  }

  /** 移除某平台的人工价覆盖，让官方 API 回到官方自动价。 */
  const clearManualPrices = async (provider) => {
    await manualReady
    if (state.manual?.providers?.[provider]) {
      const providers = { ...state.manual.providers }
      delete providers[provider]
      state.manual = { version: 1, providers }
      await writeJsonFile(manualFile, state.manual)
    }
    rebuildPricer({ config, state, store })
    return priceReport({
      snapshot: state.snapshot,
      config,
      providers: state.providers,
      names: store.platformNames(),
      manual: state.manual,
      official: state.official,
      officialProviders: state.officialProviders,
      activeModels: store.providerModels(),
    })
  }

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      await storeReady
      state.providers = [
        ...new Set([
          ...Object.keys(store.providerModels()),
          ...Object.keys(state.manual.providers),
        ]),
      ]
      // 历史数据里可能还有目录未登记的官方 provider id；出现即纳入官方价。
      for (const provider of state.providers) {
        if (isDeepSeekOfficialProvider({ provider })) state.officialProviders.add(provider)
      }
      state.snapshot = await readJsonFile(priceFile)
      // 旧版 prices.json 是官网解析结果，来源不同；等这次 models.dev 同步重建。
      if (state.snapshot && state.snapshot.version !== 3) state.snapshot = null
      const savedManual = await readJsonFile(manualFile)
      state.manual = savedManual?.providers && typeof savedManual.providers === 'object'
        ? { version: 1, providers: savedManual.providers }
        : { version: 1, providers: {} }
      resolveManualReady?.()
      const loaded = await loadCatalog({ cacheFile: catalogFile })
      state.catalog = loaded.catalog
      state.catalogSource = loaded.source
      state.catalogError = loaded.error
      rebuildPricer({ config, state, store })
      if (state.officialProviders.size > 0) {
        void refreshOfficialPricing().catch((error) => {
          ctx.logger?.warn?.(`dsh-billing-statistics: DeepSeek 官方价读取失败：${String(error?.message ?? error)}`)
        })
      }
      ctx.logger?.info?.(`dsh-billing-statistics: 计量已就绪，数据目录 ${store.directory}`)
      if (config?.priceSync === false) return
      // 每天自动刷新一次 models.dev；今天没刷新过（含当时程序没开）就补上。
      if (state.snapshot?.day !== todayKey(config) || !state.catalog) {
        void syncPrices({ forceRefresh: true }).catch((error) => {
          ctx.logger?.warn?.(`dsh-billing-statistics: 启动时同步价格失败：${String(error?.message ?? error)}`)
        })
      }
    })()
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-billing-statistics: 初始化失败：${String(error?.message ?? error)}`)
      })
      .finally(() => {
        resolveManualReady?.()
        if (disposed) void store.close()
      })

    // 程序跨天常开时，新的一天也会补抓一次（每半小时看一眼，抓过就跳过）。
    const dailyTimer = setInterval(() => {
      if (config?.priceSync === false) return
      if (state.snapshot?.day === todayKey(config)) return
      void syncPrices({ forceRefresh: true }).catch((error) => {
        ctx.logger?.warn?.(`dsh-billing-statistics: 每日同步价格失败：${String(error?.message ?? error)}`)
      })
    }, 30 * 60 * 1000)
    dailyTimer.unref?.()

    return async () => {
      disposed = true
      clearInterval(dailyTimer)
      await store.close()
    }
  })

  ctx.effect(() => {
    /** 该平台是否已有可用的 models.dev 价表（有价且不是失败态）。 */
    const pricedProvider = (provider) => {
      const page = state.snapshot?.providers?.[provider]
      return Boolean(page && page.ok !== false && page.models && Object.keys(page.models).length > 0)
    }
    const asked = new Set()
    const off = ctx.on('llm/stream', (options, next) => {
      // 新平台当天首次出现时补检索一次 models.dev；已有价表则跳过。
      const provider = String(options?.provider ?? '')
      const key = provider + '|' + todayKey(config)
      if (provider && provider !== 'unknown' && !asked.has(key) && !pricedProvider(provider)) {
        asked.add(key)
        void syncPrices({ only: [provider] }).catch((error) => {
          ctx.logger?.warn?.('dsh-billing-statistics: 补检索平台价格失败（' + provider + '）：' + String(error?.message ?? error))
        })
      }
      return captureAttempt(store, options, next)
    })
    return () => off?.()
  })

  ctx.effect(() => {
    const handler = async (request, response) => {
      try {
        if (!admitted(ctx, request)) {
          sendJson(response, 403, { error: 'forbidden' })
          return
        }
        const pathname = new URL(String(request.url ?? '/'), 'http://localhost').pathname
        if (pathname === PRICES_OFFICIAL_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const query = new URL(String(request.url ?? '/'), 'http://localhost').searchParams
          const provider = String(query.get('provider') ?? '')
          try {
            await refreshOfficialPricing({ force: query.get('refresh') === '1' })
          } catch (error) {
            // refreshOfficialPricing 正常不会抛；这里再兜一层，页面拿到内置表而不是 500。
            ctx.logger?.warn?.(`dsh-billing-statistics: 官方价接口失败：${String(error?.message ?? error)}`)
          }
          sendJson(response, 200, officialPayload(provider))
          return
        }
        if (pathname === SUMMARY_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const summary = store.summary({ days: parseDays(request), year: parseYear(request) })
          const activeModels = store.providerModels()
          // 未定价模型标记出来，页面据此提示「花费只统计已定价的部分」。
          // 用 provider/model 形式，正好可以照抄进配置的 pricing。
          const unpriced = summary.platforms.flatMap((platform) =>
            platform.models
              .filter((model) => model.price.source === SOURCE_NONE)
              .map((model) => `${platform.provider}/${model.model}`),
          )
          const providers = [
            ...new Set([
              ...summary.platforms.map((platform) => platform.provider),
              ...Object.keys(state.manual?.providers ?? {}),
              ...state.providers,
            ]),
          ]
          sendJson(response, 200, {
            ok: true,
            ...summary,
            unpricedModels: unpriced,
            prices: priceReport({
              snapshot: state.snapshot,
              config,
              providers,
              names: store.platformNames(),
              manual: state.manual,
              official: state.official,
              officialProviders: state.officialProviders,
              activeModels,
            }),
          })
          return
        }
        if (pathname === EXPORT_REPORT_PATH) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const { summary, detail, details } = exportPayload(store, request)
          const html = buildReport(summary, { generatedAt: Date.now(), details, detail })
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': `attachment; filename="llm-usage-${todayKey(config)}.html"`,
            'cache-control': 'no-store',
          })
          response.end(request.method === 'HEAD' ? undefined : html)
          return
        }
        if (pathname === EXPORT_PDF_PATH) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          try {
            const { summary, detail, details } = exportPayload(store, request)
            const pdf = await buildPdf(summary, { generatedAt: Date.now(), details, detail })
            response.writeHead(200, {
              'content-type': 'application/pdf',
              'content-disposition': `attachment; filename="llm-usage-${todayKey(config)}.pdf"`,
              'cache-control': 'no-store',
            })
            response.end(request.method === 'HEAD' ? undefined : pdf)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-billing-statistics: PDF 导出失败：${String(error?.message ?? error)}`)
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }
        if (pathname === EXPORT_CSV_PATH) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const csv = buildCsv(store.summary({ days: parseDays(request), year: parseYear(request) }), { generatedAt: Date.now() })
          response.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="llm-usage-${todayKey(config)}.csv"`,
            'cache-control': 'no-store',
          })
          // BOM：Excel 双击打开不乱码。
          response.end(request.method === 'HEAD' ? undefined : `\ufeff${csv}`)
          return
        }
        if (pathname === RESET_PATH) {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          await store.reset()
          sendJson(response, 200, { ok: true, resetAt: Date.now() })
          return
        }
        if (pathname === MODEL_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const query = new URL(String(request.url ?? '/'), 'http://localhost').searchParams
          const provider = (query.get('provider') ?? '').trim()
          const model = (query.get('model') ?? '').trim()
          if (!provider || !model) {
            sendJson(response, 400, { error: 'provider-and-model-required' })
            return
          }
          const detail = store.modelDetail({ provider, model, days: parseDays(request), year: parseYear(request) })
          sendJson(response, 200, { ok: true, ...detail })
          return
        }
        if (pathname === RECONCILE_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const query = new URL(String(request.url ?? '/'), 'http://localhost').searchParams
          const requested = String(query.get('day') ?? '').trim()
          const day = requested ? parseDay(requested) : todayKey(config)
          if (!day) {
            sendJson(response, 400, { error: 'invalid-day' })
            return
          }
          sendJson(response, 200, { ok: true, ...store.dayTotals(day) })
          return
        }
        if (pathname === PRICES_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          state.providers = [
            ...new Set([
              ...Object.keys(store.providerModels()),
              ...Object.keys(state.manual?.providers ?? {}),
            ]),
          ]
          sendJson(response, 200, {
            ok: true,
            prices: priceReport({
              snapshot: state.snapshot,
              config,
              providers: state.providers,
              names: store.platformNames(),
              manual: state.manual,
              official: state.official,
              officialProviders: state.officialProviders,
              activeModels: store.providerModels(),
            }),
          })
          return
        }
        if (pathname === PRICES_SYNC_PATH) {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          const report = await syncPrices({ forceRefresh: true })
          sendJson(response, 200, { ok: true, prices: report })
          return
        }
        if (pathname === PRICES_IMPORT_PATH) {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          const body = await readJsonBody(request, 262144)
          const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
          const currency = body?.currency === 'USD' ? 'USD' : 'CNY'
          if (!body || !provider) {
            sendJson(response, 400, { error: 'provider-required' })
            return
          }
          const isOfficial = isOfficialPricingProvider(provider, state.officialProviders)
          if (body.clear === true) {
            if (!isOfficial) {
              sendJson(response, 400, { error: 'official-only', message: '只有 DeepSeek 官方平台可恢复自动价' })
              return
            }
            try {
              const report = await clearManualPrices(provider)
              sendJson(response, 200, { ok: true, prices: report })
            } catch (error) {
              sendJson(response, 500, { error: 'clear-failed', message: String(error?.message ?? error) })
            }
            return
          }
          if (!body.models || typeof body.models !== 'object') {
            sendJson(response, 400, { error: 'invalid-prices', message: '缺少模型价格表' })
            return
          }
          try {
            const hasPeak = Object.prototype.hasOwnProperty.call(body, 'peak')
            const peak = hasPeak
              ? normalizeManualPeak(body.peak)
              : state.manual?.providers?.[provider]?.peak ?? null
            const report = await importManualPrices(
              provider,
              body.models,
              currency,
              peak,
              // 新版弹窗会显式带 true/false；旧版客户端没有这个字段，
              // 但用户点保存就是想要人工覆盖，按 true 兼容。
              isOfficial && body.officialOverride !== false,
            )
            sendJson(response, 200, { ok: true, prices: report })
          } catch (error) {
            sendJson(response, 400, { error: 'invalid-prices', message: String(error?.message ?? error) })
          }
          return
        }
        sendJson(response, 404, { error: 'not-found' })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-billing-statistics: 路由处理失败：${String(error?.message ?? error)}`)
        try {
          sendJson(response, 500, { error: 'internal-error' })
        } catch {
          // 响应已经结束时不再补写。
        }
      }
    }
    const disposes = []
    for (const path of ROUTES) {
      // 单个路由被占用或宿主契约变化时，保留其余接口，不要整组放弃。
      try {
        disposes.push(ctx.webServer.register({ kind: 'exact', path, handler }))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-billing-statistics: 注册接口失败（${path}）：${String(error?.message ?? error)}`)
      }
    }
    return () => {
      for (const dispose of disposes) {
        try {
          dispose()
        } catch {
          // 忽略重复释放
        }
      }
    }
  })
}
