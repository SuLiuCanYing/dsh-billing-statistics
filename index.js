/**
 * llm-usage-insights —— Host 半边。
 *
 * 采集：挂在 `llm/stream` 瀑布上包裹每一次模型请求尝试，从流里读 provider、
 *       model、usage 与 finish，写入按「平台 × 模型 × 小时」聚合的计数器。
 * 价格：每个平台一个官网价格页链接（页面可填，没填就自动搜索填入）；抓到的价格
 *       按平台缓存，含峰谷时段与阶梯价；抓不到时回退内置估算价，配置的 pricing 优先级最高。
 *       自动同步每天一次，错过的时间段在下次启动时补抓。
 * 持久化：`$DSH_HOME/llm-usage-insights/usage.json`、`prices.json`、`sources.json`（原子写）。
 * 接口：summary / reset / prices / prices/sync / sources（exact Web 路由，同一来源校验）。
 */

import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { UsageStore } from './usage-store.js'
import { SOURCE_NONE, beijingParts, createPricer } from './pricing.js'
import { discoverPriceUrl, fetchPricePage, knownFeedFor } from './price-source.js'

/** 路由前缀；页面就按这个路径取数。 */
export const API_PREFIX = '/api/llm-usage/v1'
const SUMMARY_PATH = `${API_PREFIX}/summary`
const RESET_PATH = `${API_PREFIX}/reset`
const PRICES_PATH = `${API_PREFIX}/prices`
const PRICES_SYNC_PATH = `${API_PREFIX}/prices/sync`
const SOURCES_PATH = `${API_PREFIX}/sources`
const MODEL_PATH = `${API_PREFIX}/model`

const rateSchema = Schema.object({
  input: Schema.number().min(0).default(0).description('输入（未命中缓存）元 / 百万 token。Input tokens (cache miss), CNY per 1M tokens.'),
  output: Schema.number().min(0).default(0).description('输出元 / 百万 token。Output tokens, CNY per 1M tokens.'),
  cacheRead: Schema.number().min(0).default(0).description('缓存命中读取 元 / 百万 token。Cache-hit reads, CNY per 1M tokens.'),
  cacheWrite: Schema.number().min(0).default(0).description('缓存写入 元 / 百万 token。Cache writes, CNY per 1M tokens.'),
})

export const Config = Schema.object({
  retainDays: Schema.number()
    .min(1)
    .max(3660)
    .default(30)
    .description('按天明细的保留天数（默认一个月）；更早的分桶在下次启动时清理。 Days of per-day detail kept; older buckets are pruned on next start.'),
  showCost: Schema.boolean().default(true).description('页面上是否显示花费列与花费合计。 Whether the cost column and totals are shown in the panel.'),
  priceSync: Schema.boolean()
    .default(true)
    .description('每天自动同步一次官网价格；当天时段没开程序的话，下次启动时补抓一次。 Sync official prices once a day; if the app was closed, catch up on next start.'),
  autoDiscover: Schema.boolean()
    .default(true)
    .description('没填官网链接的平台，自动搜索价格页并填入（只采纳命中「价格/计费」页的结果，填错可手改）。 Auto-discover pricing pages for providers without a feed URL; only pricing-looking pages are accepted and the result stays editable.'),
  priceFeeds: Schema.dict(Schema.string())
    .default({})
    .description(
      'provider → 官网价格页链接的预设值；页面里每个平台后面的输入框会覆盖这里的值。 Preset provider → pricing-page URL; the per-provider input overrides it.' +
        '留空表示靠自动搜索；写空字符串表示该平台不查官网、直接用内置规则。 Empty = auto-discovery; a blank string = built-in rules only.',
    ),
  usdToCny: Schema.number()
    .min(0.1)
    .max(100)
    .default(7.1)
    .description('通用页面解析到美元价（$）时，按这个汇率折成人民币计入花费。 Rate used to convert USD prices from generic pages into CNY.'),
  peakHolidays: Schema.array(Schema.string())
    .default([])
    .description(
      '视为「空闲时段」的日期（YYYY-MM-DD，北京时间），用于 DeepSeek 这类工作日峰谷价。 Dates (YYYY-MM-DD, UTC+8) treated as off-peak, e.g. Chinese public holidays. ' +
        '中国法定节假日可填在这里，避免节假日按高峰价估算。',
    ),
  pricing: Schema.dict(rateSchema)
    .default({})
    .description(
      '每百万 token 的价格表，键可以是 provider、provider/model（模型 id 里的斜杠不影响匹配）或 *。 Price table per 1M tokens; keys may be provider, provider/model, or *. ' +
        '写了同名键会整体覆盖官网/内置价格；全 0 视为未定价。 A matching key overrides official/built-in prices; all zeros mean unpriced.',
    ),
})

export const inject = ['llm', 'webServer']

/** 数据目录：$DSH_HOME/llm-usage-insights。 */
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
        if (!entry || typeof entry !== 'object') return null
        const provider = typeof entry.provider === 'string' ? entry.provider : ''
        if (!provider) return null
        return {
          provider,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
        }
      })
      .filter(Boolean)
  } catch (error) {
    ctx.logger?.debug?.(`llm-usage: 读取 provider 目录失败：${String(error?.message ?? error)}`)
    return []
  }
}

/** 流里的 usage 块归一化。字段缺失时按 0。 */
function readUsage(chunk) {
  const usage = chunk?.usage
  if (!usage || typeof usage !== 'object') return null
  return usage
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
          // usage 可能出现在任意位置（一般是 finish 之前），始终记录。
          if (chunk?.type === 'usage') usage = readUsage(chunk) ?? usage
          else if (!sawTerminal && chunk?.type === 'finish') {
            sawTerminal = true
            const reason = chunk.reason ?? chunk.finishReason
            if (reason?.kind === 'error') outcome = 'failed'
            else if (reason?.kind === 'aborted') outcome = 'aborted'
          }
          yield chunk
        }
      } catch (error) {
        outcome = 'failed'
        throw error
      } finally {
        try {
          store.recordCall({ provider, model, outcome, usage: usage ?? undefined })
        } catch (error) {
          // 记账绝不能影响模型调用本身。
          store.logger?.warn?.(`llm-usage: 记账失败：${String(error?.message ?? error)}`)
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
      if (rejection !== undefined) return false
      return true
    } catch {
      return false
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
  const temporary = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(payload), 'utf8')
  await rename(temporary, file)
}

/** 今天（北京时间）；自动同步按这个粒度判断「今天抓过没有」。 */
function todayKey() {
  return beijingParts(Date.now()).dayKey
}

/** 某个平台当前用的官网链接（手填 > 配置预设 > 已知平台默认页）。 */
function sourceUrlFor(provider, { sources, config, names }) {
  const stored = sources?.[provider]
  if (stored?.url) return { url: stored.url, origin: stored.origin || 'manual' }
  const preset = config?.priceFeeds?.[provider]
  if (typeof preset === 'string' && preset.trim()) return { url: preset.trim(), origin: 'config' }
  const known = knownFeedFor(provider, names?.[provider] ?? '')
  if (known) return { url: known.url, origin: 'builtin' }
  return { url: '', origin: '' }
}

/** 把自动搜索失败的原因归类，页面据此给用户可操作的提示。 */
function classifySearchFailure(reason) {
  const text = String(reason ?? '')
  if (!text) return ''
  if (/宿主未提供搜索服务|未提供搜索服务/.test(text)) return 'unavailable'
  if (/no API key|DEEPSEEK_API_KEY|credential/i.test(text)) return 'credential'
  if (/没有明确|未找到价格页/.test(text)) return 'no-result'
  return 'failed'
}

/** 汇总当前价格状态（供页面显示每个平台的链接、来源与同步时间）。 */
function priceReport({ snapshot, config, sources, providers, names }) {
  const cached = snapshot?.providers ?? {}
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : []
  const entries = providers.map((provider) => {
    const source = sourceUrlFor(provider, { sources, config, names })
    const page = cached[provider]
    return {
      provider,
      title: names?.[provider] || provider,
      url: page?.url || source.url,
      origin: page?.origin || source.origin,
      ok: Boolean(page?.ok),
      missing: Boolean(page?.missing),
      searchFailed: Boolean(page?.searchFailed),
      searchReason: page?.searchReason ?? '',
      searchCode: page?.searchCode ?? '',
      error: page?.error ?? '',
      feedId: page?.feedId ?? '',
      currency: page?.currency ?? 'CNY',
      models: page?.models ? Object.keys(page.models).length : 0,
      fetchedAt: Number(page?.fetchedAt) || 0,
    }
  })
  const day = typeof snapshot?.day === 'string' ? snapshot.day : ''
  return {
    enabled: config?.priceSync !== false,
    autoDiscover: config?.autoDiscover !== false,
    fetchedAt: Number(snapshot?.fetchedAt) || 0,
    day,
    today: todayKey(),
    syncedToday: day === todayKey(),
    stale: day !== todayKey(),
    providers: entries,
    errors,
  }
}

/**
 * 同步官网价格：按平台解析 → 写 prices.json → 重建计价器。
 * 单个平台失败时保留它上一次的价格；自动搜索失败的平台下次启动再试。
 * @param {{ ctx: any, config: any, file: string, sourcesFile: string, store: UsageStore, state: any }} input
 */
function createPriceSync({ ctx, config, file, sourcesFile, store, state }) {
  let running = null

  const saveSource = async (provider, patch) => {
    state.sources = {
      ...(state.sources ?? {}),
      [provider]: { ...(state.sources?.[provider] ?? {}), ...patch, updatedAt: Date.now() },
    }
    try {
      await writeJsonFile(sourcesFile, { version: 1, sources: state.sources })
    } catch (error) {
      ctx.logger?.warn?.(`llm-usage: 保存平台链接失败：${String(error?.message ?? error)}`)
    }
  }

  const clearSource = async (provider) => {
    const next = { ...(state.sources ?? {}) }
    delete next[provider]
    state.sources = next
    try {
      await writeJsonFile(sourcesFile, { version: 1, sources: state.sources })
    } catch (error) {
      ctx.logger?.warn?.(`llm-usage: 清除平台链接失败：${String(error?.message ?? error)}`)
    }
  }

  const run = async ({ only = null } = {}) => {
    const names = store.platformNames()
    const modelsByProvider = store.providerModels()
    // 只处理真正用过的平台，以及用户填过 / 配置里写过链接的平台；
    // 不遍历整个 provider 目录（几十个没用过的平台会被无谓地抓一遍）。
    const active = new Set([
      ...Object.keys(modelsByProvider),
      ...Object.keys(state.sources ?? {}),
      ...Object.keys(config?.priceFeeds ?? {}),
    ])
    state.providers = [...active]
    const targets = [...active]
    const previous = state.snapshot?.providers ?? {}
    const table = { ...previous }
    const errors = []
    let okNow = 0

    for (const provider of targets) {
      if (only && !only.includes(provider)) continue
      const { url: presetUrl, origin: presetOrigin } = sourceUrlFor(provider, {
        sources: state.sources,
        config,
        names,
      })
      let url = presetUrl
      let origin = presetOrigin
      let searchFailure = ''

      if (!url && config?.autoDiscover !== false) {
        let web
        try {
          web = ctx.get('web')
        } catch {
          web = undefined
        }
        const found = await discoverPriceUrl(web, provider, names[provider] ?? '')
        if (found.url) {
          url = found.url
          origin = 'auto'
          await saveSource(provider, { url, origin: 'auto', reason: found.reason })
          ctx.logger?.info?.(`llm-usage: 为 ${provider} 自动填入价格页 ${url}（${found.reason}）`)
        } else {
          searchFailure = found.reason
          errors.push({ provider, title: names[provider] || provider, message: `自动搜索未找到价格页：${found.reason}` })
        }
      }

      if (!url) {
        const stale = previous[provider] ?? {}
        table[provider] = {
          ...stale,
          provider,
          url: '',
          origin,
          ok: false,
          missing: true,
          error: '',
          searchFailed: Boolean(searchFailure),
          searchReason: searchFailure,
          searchCode: classifySearchFailure(searchFailure),
          models: stale.models ?? {},
          fetchedAt: Number(stale.fetchedAt) || 0,
        }
        continue
      }

      try {
        const page = await fetchPricePage({ url }, { modelIds: modelsByProvider[provider] ?? [] })
        okNow += 1
        table[provider] = {
          provider,
          url,
          origin,
          feedId: page.feedId,
          currency: page.currency,
          fetchedAt: page.fetchedAt,
          ok: true,
          error: '',
          models: page.models,
          aliases: page.aliases,
        }
      } catch (error) {
        const message = String(error?.message ?? error)
        errors.push({ provider, title: names[provider] || provider, message })
        ctx.logger?.warn?.(`llm-usage: 价格同步失败（${provider}）：${message}`)
        // 失败保留上一次该平台的价格，避免整页掉价。
        table[provider] = { ...(previous[provider] ?? {}), provider, url, origin, ok: false, error: message }
      }
    }

    const anyOk = okNow > 0
    const snapshot = {
      version: 2,
      fetchedAt: anyOk ? Date.now() : Number(state.snapshot?.fetchedAt) || 0,
      day: anyOk ? todayKey() : (state.snapshot?.day ?? ''),
      providers: table,
      errors: errors.slice(0, 12),
    }
    state.snapshot = snapshot
    try {
      await writeJsonFile(file, snapshot)
    } catch (error) {
      ctx.logger?.warn?.(`llm-usage: 写入价格表失败：${String(error?.message ?? error)}`)
    }
    rebuildPricer({ config, state, store })
    return priceReport({ snapshot, config, sources: state.sources, providers: state.providers, names })
  }

  const sync = async (options) => {
    if (running) return running
    running = run(options).finally(() => {
      running = null
    })
    return running
  }
  sync.saveSource = saveSource
  sync.clearSource = clearSource
  return sync
}

/** 用当前价格快照重建计价器，并让 store 重算历史花费。 */
function rebuildPricer({ config, state, store }) {
  const providers = {}
  for (const [provider, page] of Object.entries(state.snapshot?.providers ?? {})) {
    if (!page?.models || Object.keys(page.models).length === 0) continue
    providers[provider] = {
      models: page.models,
      currency: page.currency ?? 'CNY',
      aliases: page.aliases ?? {},
      url: page.url ?? '',
      feedId: page.feedId ?? '',
    }
  }
  const pricer = createPricer({
    custom: config?.pricing ?? {},
    providers,
    holidays: Array.isArray(config?.peakHolidays) ? config.peakHolidays : [],
    usdToCny: Number(config?.usdToCny) || 7.1,
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
  const directory = dataDirectory()
  const priceFile = join(directory, 'prices.json')
  const sourcesFile = join(directory, 'sources.json')
  /** 共享的可变状态：价格快照、平台链接、provider 列表。 */
  const state = { snapshot: null, sources: {}, providers: [] }

  const store = new UsageStore({
    directory,
    retainDays: config?.retainDays ?? 90,
    pricer: createPricer({ custom: config?.pricing ?? {}, holidays: config?.peakHolidays ?? [] }),
    listProviders: () => providerDirectory(ctx),
    showCost: config?.showCost !== false,
    logger: ctx.logger,
  })

  const syncPrices = createPriceSync({ ctx, config, file: priceFile, sourcesFile, store, state })

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      await store.load()
      state.providers = [
        ...new Set([...Object.keys(store.providerModels()), ...Object.keys(config?.priceFeeds ?? {})]),
      ]
      state.snapshot = await readJsonFile(priceFile)
      const savedSources = await readJsonFile(sourcesFile)
      state.sources = savedSources?.sources && typeof savedSources.sources === 'object' ? savedSources.sources : {}
      rebuildPricer({ config, state, store })
      ctx.logger?.info?.(`llm-usage: 计量已就绪，数据目录 ${store.directory}`)
      if (config?.priceSync === false) return
      // 每天自动抓一次：今天没抓过（含「当时程序没开」）就在启动时补上。
      if (state.snapshot?.day !== todayKey()) {
        void syncPrices().catch((error) => {
          ctx.logger?.warn?.(`llm-usage: 启动时同步价格失败：${String(error?.message ?? error)}`)
        })
      }
    })()
      .catch((error) => {
        ctx.logger?.warn?.(`llm-usage: 初始化失败：${String(error?.message ?? error)}`)
      })
      .finally(() => {
        if (disposed) void store.close()
      })

    // 程序跨天常开时，新的一天也会补抓一次（每半小时看一眼，抓过就跳过）。
    const dailyTimer = setInterval(() => {
      if (config?.priceSync === false) return
      if (state.snapshot?.day === todayKey()) return
      void syncPrices().catch((error) => {
        ctx.logger?.warn?.(`llm-usage: 每日同步价格失败：${String(error?.message ?? error)}`)
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
    const off = ctx.on('llm/stream', (options, next) => captureAttempt(store, options, next))
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
        if (pathname === SUMMARY_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const summary = store.summary({ days: parseDays(request) })
          // 未定价模型标记出来，页面据此提示「花费只统计已定价的部分」。
          // 用 provider/model 形式，正好可以照抄进配置的 pricing。
          const unpriced = summary.platforms.flatMap((platform) =>
            platform.models
              .filter((model) => model.price.source === SOURCE_NONE)
              .map((model) => `${platform.provider}/${model.model}`),
          )
          const providers = [
            ...new Set([...summary.platforms.map((platform) => platform.provider), ...Object.keys(state.sources ?? {})]),
          ]
          sendJson(response, 200, {
            ok: true,
            ...summary,
            unpricedModels: unpriced,
            prices: priceReport({
              snapshot: state.snapshot,
              config,
              sources: state.sources,
              providers,
              names: store.platformNames(),
            }),
          })
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
          const detail = store.modelDetail({ provider, model, days: parseDays(request) })
          sendJson(response, 200, { ok: true, ...detail })
          return
        }
        if (pathname === PRICES_PATH) {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          state.providers = [
            ...new Set([...Object.keys(store.providerModels()), ...Object.keys(state.sources ?? {})]),
          ]
          sendJson(response, 200, {
            ok: true,
            prices: priceReport({
              snapshot: state.snapshot,
              config,
              sources: state.sources,
              providers: state.providers,
              names: store.platformNames(),
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
          const report = await syncPrices()
          sendJson(response, 200, { ok: true, prices: report })
          return
        }
        if (pathname === SOURCES_PATH) {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          const body = await readJsonBody(request)
          const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
          const url = typeof body?.url === 'string' ? body.url.trim() : ''
          if (!provider) {
            sendJson(response, 400, { error: 'provider-required' })
            return
          }
          if (url && !/^https?:\/\//i.test(url)) {
            sendJson(response, 400, { error: 'invalid-url' })
            return
          }
          if (url) await syncPrices.saveSource(provider, { url, origin: 'manual', reason: '手动填写' })
          else await syncPrices.clearSource(provider)
          const report = await syncPrices({ only: [provider] })
          sendJson(response, 200, { ok: true, prices: report })
          return
        }
        sendJson(response, 404, { error: 'not-found' })
      } catch (error) {
        ctx.logger?.warn?.(`llm-usage: 路由处理失败：${String(error?.message ?? error)}`)
        try {
          sendJson(response, 500, { error: 'internal-error' })
        } catch {
          // 响应已经结束时不再补写。
        }
      }
    }
    const disposes = []
    try {
      for (const path of [SUMMARY_PATH, RESET_PATH, MODEL_PATH, PRICES_PATH, PRICES_SYNC_PATH, SOURCES_PATH]) {
        disposes.push(ctx.webServer.register({ kind: 'exact', path, handler }))
      }
    } catch (error) {
      ctx.logger?.warn?.(`llm-usage: 注册接口失败：${String(error?.message ?? error)}`)
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
