/**
 * 官网价格抓取。
 *
 * 两类来源：
 * 1. 已知平台（硅基流动 / DeepSeek 官方）——按页面结构精确解析，支持峰谷时段与阶梯价；
 * 2. 任意平台——用户填了官网链接（或自动搜索填入）后，用通用解析器从页面文本里
 *    按模型名附近的价格标签（输入/输出/缓存 + ¥/元）提取单价。
 *
 * 解析不出结果时抛错/返回空表，由调用方保留旧价格或退回内置规则，绝不写坏已有数据。
 */

/** 已知平台的价格页定义。`parse` 精确解析，`match(url)` 判断某个链接属于该平台。 */
export const KNOWN_FEEDS = [
  {
    id: 'siliconflow',
    title: '硅基流动 SiliconFlow',
    url: 'https://www.siliconflow.cn/pricing',
    currency: 'CNY',
    match: (url) => /(^|\.)siliconflow\.(cn|com)\//i.test(String(url)),
    parse: parseSiliconflow,
  },
  {
    id: 'deepseek',
    title: 'DeepSeek 官方',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    currency: 'CNY',
    match: (url) => /api-docs\.deepseek\.com|platform\.deepseek\.com|deepseek\.com\/.*pricing/i.test(String(url)),
    parse: parseDeepseek,
    aliases: {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      'deepseek-chat': 'deepseek-flash',
      'deepseek-reasoner': 'deepseek-v4-pro',
    },
  },
]

/** provider 名字 → 已知平台（未填链接时用）。 */
export function knownFeedFor(provider, displayName = '') {
  const haystack = `${provider} ${displayName}`.toLowerCase()
  if (haystack.includes('siliconflow') || haystack.includes('硅基流动')) return KNOWN_FEEDS[0]
  if (haystack.includes('deepseek')) return KNOWN_FEEDS[1]
  return null
}

/** 找匹配某个 URL 的已知平台解析器。 */
export function feedForUrl(url) {
  return KNOWN_FEEDS.find((feed) => feed.match(url)) ?? null
}

/**
 * 抓取并解析一个平台的官网价格页。
 * @param {{ url: string, id?: string, aliases?: Record<string,string> }} source
 * @param {{ timeoutMs?: number, modelIds?: string[] }} [options]
 * @returns {Promise<{url: string, feedId: string, currency: string, fetchedAt: number, models: Record<string, any>, aliases: Record<string,string>}>}
 */
export async function fetchPricePage(source, { timeoutMs = 15000, modelIds = [] } = {}) {
  const url = String(source?.url ?? '')
  if (!url) throw new Error('未填写官网链接')
  let response
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) llm-usage-insights/1.1',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`抓取失败：${error?.message ?? error}`)
  }
  if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`)
  const html = await response.text()

  const feed = feedForUrl(url)
  const models = feed ? feed.parse(html) : parseGeneric(html, modelIds)
  if (!models || Object.keys(models).length === 0) {
    throw new Error(feed ? '页面结构变化，未解析到价格' : '未从页面中识别到价格（可改用内置规则）')
  }
  return {
    url,
    feedId: feed?.id ?? 'generic',
    currency: Object.values(models)[0]?.currency ?? 'CNY',
    fetchedAt: Date.now(),
    models,
    aliases: feed?.aliases ?? {},
  }
}

/**
 * 自动搜索价格页链接（仅当用户没填时使用）。
 * @param {{ search?: Function } | undefined} web ctx.web 服务（可选）
 * @param {string} provider provider id
 * @param {string} [displayName]
 */
export async function discoverPriceUrl(web, provider, displayName = '') {
  if (!web || typeof web.search !== 'function') return { url: '', reason: '宿主未提供搜索服务' }
  const query = `${displayName || provider} 模型 API 价格 官网 计费`
  try {
    const result = await web.search({ query, maxResults: 6 }, AbortSignal.timeout(15000))
    const sources = (result?.sources ?? []).filter((entry) => /^https?:\/\//i.test(String(entry?.url ?? '')))
    if (sources.length === 0) return { url: '', reason: '搜索没有返回结果' }
    const pricey = sources.find((entry) => /price|pricing|billing|价格|计费|收费/i.test(`${entry.url} ${entry.title ?? ''}`))
    const token = String(provider).toLowerCase().split(/[-_.\s]/)[0]
    const named = sources.find((entry) => token.length >= 3 && String(entry.url).toLowerCase().includes(token))
    const picked = pricey ?? named ?? null
    if (!picked) return { url: '', reason: '搜索结果里没有明确的价格页' }
    return { url: String(picked.url), reason: pricey ? '按关键词命中价格页' : '按域名匹配平台' }
  } catch (error) {
    return { url: '', reason: `搜索失败：${error?.message ?? error}` }
  }
}

/* ── 通用页面解析 ─────────────────────────────────────────── */

/** HTML → 纯文本（保留换行，便于按位置找标签与价格）。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
}

const MONEY_RE = /[¥￥]\s*([\d]+(?:\.\d+)?)|([\d]+(?:\.\d+)?)\s*元|\$\s*([\d]+(?:\.\d+)?)/g

/** 收集文本里的价格 token（值 + 位置 + 币种）。 */
function moneyTokens(text) {
  const tokens = []
  MONEY_RE.lastIndex = 0
  let match
  while ((match = MONEY_RE.exec(text)) !== null) {
    const value = Number(match[1] ?? match[2] ?? match[3])
    if (!Number.isFinite(value) || value <= 0 || value > 5000) continue
    const currency = match[3] !== undefined && match[1] === undefined && match[2] === undefined ? 'USD' : 'CNY'
    tokens.push({ value, index: match.index, currency })
  }
  return tokens
}

/** 找标签附近最近的价格（优先标签后 40 字内，其次标签前 40 字内）。 */
function priceNearLabel(text, labelRe, tokens) {
  const labelReGlobal = new RegExp(labelRe.source, 'g')
  let label
  while ((label = labelReGlobal.exec(text)) !== null) {
    const start = label.index
    const end = start + label[0].length
    const after = tokens.find((token) => token.index >= end && token.index - end <= 40)
    if (after) return after
    const before = [...tokens].reverse().find((token) => token.index < start && start - token.index <= 40)
    if (before) return before
  }
  return null
}

/** 从 from 之后最近的「其他模型名」位置，用来把解析窗口限制在同一个模型的行内。 */
function nextNameIndex(text, names, from) {
  let best = text.length
  for (const name of names) {
    const index = text.indexOf(name, from)
    if (index >= 0 && index < best) best = index
  }
  return best
}

/**
 * 通用解析：在「模型名」同一行的文本里找 输入/输出/缓存 单价。
 * 只接受人民币或美元，至少要有输入与输出两项才算成功。
 */
export function parseGeneric(html, modelIds = []) {
  const text = htmlToText(html)
  const tokens = moneyTokens(text)
  if (tokens.length === 0) return {}
  const models = {}

  /** 所有模型名（含去掉厂商前缀的短名），用于划定行边界。 */
  const candidateMap = new Map()
  const allNames = []
  for (const rawId of modelIds) {
    const id = String(rawId ?? '').trim()
    if (!id) continue
    const segments = id.split('/')
    const names = [...new Set([id, segments[segments.length - 1], segments[segments.length - 1].replace(/[-_.]v?\d.*$/i, '')])]
      .filter((name) => name && name.length >= 3)
    candidateMap.set(id, names)
    for (const name of names) if (!allNames.includes(name)) allNames.push(name)
  }

  const tokensIn = (from, to) =>
    tokens
      .filter((token) => token.index >= from && token.index <= to)
      .map((token) => ({ ...token, index: token.index - from }))

  /** 在一个窗口里按标签取价；取不到标签时按出现顺序补齐。 */
  const readWindow = (from, to) => {
    if (to <= from) return null
    const windowText = text.slice(from, to)
    const localTokens = tokensIn(from, to)
    if (localTokens.length === 0) return null
    const input = priceNearLabel(windowText, /输入(?:价格|单价)?|input/i, localTokens)
    const output = priceNearLabel(windowText, /输出(?:价格|单价)?|output/i, localTokens)
    const cache = priceNearLabel(windowText, /缓存(?:命中|读取)?(?:价格|单价)?|cache(?: read)?/i, localTokens)
    let rate = null
    if (input && output) {
      rate = { input: input.value, output: output.value, cacheRead: cache?.value ?? 0, cacheWrite: 0 }
    } else if (localTokens.length >= 2) {
      // 没有标签时按出现顺序当 输入/输出/缓存（常见表格顺序）。
      const ordered = [...localTokens].sort((a, b) => a.index - b.index)
      rate = { input: ordered[0].value, output: ordered[1].value, cacheRead: ordered[2]?.value ?? 0, cacheWrite: 0 }
    }
    if (!rate) return null
    if (rate.input > 500 || rate.output > 2000) return null
    return {
      rate,
      currency: input?.currency ?? localTokens[0]?.currency ?? 'CNY',
      score: (input ? 2 : 0) + (output ? 2 : 0) + (cache ? 1 : 0),
    }
  }

  for (const [id, names] of candidateMap) {
    let best = null
    for (const name of names) {
      let from = 0
      for (let seen = 0; seen < 4; seen += 1) {
        const at = text.indexOf(name, from)
        if (at < 0) break
        from = at + name.length

        // 优先看模型名之后到下一个模型名之间的内容（表格一行）。
        const boundary = nextNameIndex(text, allNames, at + name.length)
        const forward = readWindow(at + name.length, Math.min(boundary, at + name.length + 800))
        // 价格写在模型名之前的版式，退一步看模型名前面一小段。
        const backward = forward ?? readWindow(Math.max(0, at - 250), at)

        const found = forward ?? backward
        if (found && (!best || found.score > best.score)) best = found
        if (found?.score >= 5) break
      }
      if (best?.score >= 5) break
    }
    if (!best) continue
    models[id] = {
      currency: best.currency,
      free: best.rate.input === 0 && best.rate.output === 0,
      periods: [{ label: '', ranges: [[0, 24]], rate: best.rate }],
      tiers: [],
    }
  }
  return models
}

/* ── 已知平台：硅基流动 ───────────────────────────────────── */

/** 解析「0点～2点/8点～24点」这类时段标签 → [[0,2],[8,24]]。 */
function parseHourRanges(label) {
  const ranges = []
  for (const part of String(label ?? '').split('/')) {
    const match = part.match(/(\d{1,2})\s*点?\s*[～~\-—]\s*(\d{1,2})\s*点?/)
    if (!match) continue
    const from = Number(match[1])
    const to = Number(match[2])
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    ranges.push([from, to])
  }
  return ranges
}

/** 解析「输入 [0, 32k)」「输入 [128k, +∞)」这类阶梯标签 → 上限 token 数。 */
function parseTierMax(label) {
  const match = String(label ?? '').match(/\[\s*([\d.]+)\s*([kKmM]?)\s*,\s*([^)\]]+)[)\]]/)
  if (!match) return null
  const to = match[3].trim()
  if (/∞|\+/.test(to)) return Number.POSITIVE_INFINITY
  const unit = to.match(/([\d.]+)\s*([kKmM]?)/)
  if (!unit) return null
  const scale = unit[2].toLowerCase() === 'k' ? 1000 : unit[2].toLowerCase() === 'm' ? 1_000_000 : 1
  const value = Number(unit[1]) * scale
  return Number.isFinite(value) ? value : null
}

/** 读取一个价格单元格里的数值文本：¥ 2.00 / 免费 / - */
function readMoney(text) {
  const source = String(text ?? '')
  const yuan = source.match(/[¥￥]\s*([\d.]+)/)
  if (yuan) return { value: Number(yuan[1]), free: false }
  if (source.includes('免费')) return { value: 0, free: true }
  return { value: null, free: false }
}

/**
 * 硅基流动：模型一行，3 个价格列（输入 / 输出 / 缓存），峰谷价表现为
 * 「费用发生时段: …」标签 + 价格，按 3 个一组排列。
 */
function parseSiliconflow(html) {
  const models = {}
  const chunks = String(html).split('<div id="pricing-row-text-')
  for (const chunk of chunks.slice(1)) {
    const modelMatch = chunk.match(/title="([^"]+)"[^>]*>([^<]+)<\/a>/)
    if (!modelMatch) continue
    const modelId = modelMatch[1].trim()
    if (!modelId || modelId.includes(' ')) continue

    const entries = []
    for (const cell of chunk.split('<div class="flex min-h-[60px] items-center justify-between')) {
      const labelMatch = cell.match(/<span class="block">([^<]*)<\/span>/)
      const label = labelMatch ? labelMatch[1].trim() : ''
      const money = readMoney(cell)
      const dash = /text-slate-300">\s*-\s*</.test(cell)
      if (money.value === null && !dash && !money.free) continue
      entries.push({ label, value: money.value, free: money.free })
    }
    if (entries.length < 3 || entries.length % 3 !== 0) continue

    const periods = []
    const tiers = []
    let free = false
    for (let index = 0; index < entries.length; index += 3) {
      const group = entries.slice(index, index + 3)
      const label = group.find((entry) => entry.label)?.label ?? ''
      const rate = {
        input: group[0].value ?? 0,
        output: group[1].value ?? 0,
        cacheRead: group[2].value ?? 0,
        cacheWrite: 0,
      }
      if (group.some((entry) => entry.free)) free = true
      if (label.startsWith('费用发生时段')) {
        const ranges = parseHourRanges(label.replace('费用发生时段', '').replace(/[:：]/, ''))
        if (ranges.length > 0) periods.push({ label, ranges, rate })
      } else if (label.startsWith('输入')) {
        const maxPrompt = parseTierMax(label)
        if (maxPrompt !== null) tiers.push({ label, maxPrompt, rate })
      } else if (periods.length === 0 && tiers.length === 0) {
        periods.push({ label: '', ranges: [[0, 24]], rate })
      }
    }

    if (periods.length === 0 && tiers.length === 0) continue
    models[modelId] = { currency: 'CNY', free, periods, tiers }
  }
  return models
}

/* ── 已知平台：DeepSeek 官方文档 ───────────────────────────── */

/**
 * 文档价格表：模型列（deepseek-flash / deepseek-v4-pro），
 * 行按「缓存命中 / 缓存未命中 / 输出」×「空闲 / 高峰」给出人民币单价。
 * 高峰时段写在脚注段落里（北京时间周一至周五 9:00-12:00、14:00-18:00）。
 */
function parseDeepseek(html) {
  const source = String(html)
  const header = source.match(/<td>([a-z0-9.-]+)<sup>[^<]*<\/sup><\/td><td>([a-z0-9.-]+)<\/td>/i)
  if (!header) return {}
  const modelNames = [header[1].trim(), header[2].trim()]

  const cells = {}
  let category = ''
  for (const row of source.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const body = row[1]
    if (body.includes('缓存命中')) category = 'cacheRead'
    else if (body.includes('缓存未命中')) category = 'input'
    else if (body.includes('百万tokens输出')) category = 'output'
    const period = body.match(/<td>(空闲时段|高峰时段)<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/)
    if (!period || !category) continue
    const key = period[1] === '高峰时段' ? 'peak' : 'offPeak'
    cells[category] = cells[category] ?? {}
    cells[category][key] = [Number(period[2]), Number(period[3])]
  }

  if (!cells.cacheRead || !cells.input || !cells.output) return {}

  let ranges = [[9, 12], [14, 18]]
  const note = source.match(/北京时间周一至周五[^。]*?为高峰时段/)
  if (note) {
    const hours = [...note[0].matchAll(/(\d{1,2}):(\d{2})/g)].map((match) => Number(match[1]))
    if (hours.length >= 2) {
      const pairs = []
      for (let index = 0; index + 1 < hours.length; index += 2) pairs.push([hours[index], hours[index + 1]])
      if (pairs.every(([from, to]) => to > from)) ranges = pairs
    }
  }

  const models = {}
  for (const [index, name] of modelNames.entries()) {
    const rateFor = (period) => ({
      input: cells.input[period][index] ?? 0,
      output: cells.output[period][index] ?? 0,
      cacheRead: cells.cacheRead[period][index] ?? 0,
      cacheWrite: 0,
    })
    models[name] = {
      currency: 'CNY',
      free: false,
      periods: [{ label: '高峰时段', days: [1, 2, 3, 4, 5], ranges, rate: rateFor('peak') }],
      defaultRate: rateFor('offPeak'),
      tiers: [],
    }
  }
  return models
}
