/**
 * models.dev 价格目录。
 *
 * 插件不再逐站抓官网：所有价格从 models.dev 的公开结构化目录里检索。
 * 目录是 `provider -> models -> cost`（美元 / 百万 token）；这里只保留计价所需字段，
 * 并额外提供一份随插件发布的快照，供网络失败时兜底。
 */

import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CATALOG_URL = 'https://models.dev/api.json'
export const CATALOG_SOURCE = 'models.dev'
export const CATALOG_ORIGIN = 'catalog'
export const CATALOG_VERSION = 1

const SNAPSHOT_PATH = fileURLToPath(new URL('./catalog-snapshot.json', import.meta.url))

/** 把模型 / 平台名收敛成便于比较的 token（保留字母数字）。 */
function tokens(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** 平台 id 的精确键（只做大小写和空白归一）。 */
export function normalizeProviderKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * 模型 id 的比较键。
 * 去掉命名空间（取最后一个 `/` 后的部分），再统一空格、下划线、点和连字符。
 * 例如 `deepseek-ai/DeepSeek-V4.1-Flash` 与 `deepseek-v4.1-flash` 会得到同一个键。
 */
export function normalizeModelKey(value) {
  let text = String(value ?? '').trim().toLowerCase()
  const slash = text.lastIndexOf('/')
  if (slash >= 0) text = text.slice(slash + 1)
  return text.replace(/[\s_.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/** 平台 id 的候选顺序：先按常见平台别名，再按原始 id。 */
export function providerCandidates(provider, displayName = '') {
  const text = `${provider ?? ''} ${displayName ?? ''}`.toLowerCase()
  const result = []
  const add = (id) => {
    if (id && !result.includes(id)) result.push(id)
  }
  if (/siliconflow|硅基流动/.test(text)) {
    add('siliconflow-cn')
    add('siliconflow')
  }
  if (/deepseek|深度求索/.test(text)) add('deepseek')
  if (/openrouter/.test(text)) add('openrouter')
  if (/zhipu|bigmodel|智谱/.test(text)) {
    add('zhipuai')
    add('zhipu')
  }
  if (/moonshot|kimi|月之暗面/.test(text)) add('moonshotai')
  if (/alibaba|dashscope|百炼|阿里/.test(text)) add('alibaba')
  if (/minimax/.test(text)) add('minimax')
  if (/stepfun|阶跃/.test(text)) add('stepfun')
  add(normalizeProviderKey(provider))
  return result
}

/** 标准化 models.dev 的原始 API 或插件快照。 */
export function normalizeCatalog(raw, { fetchedAt = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('价格目录格式不对')
  const providers = {}
  const models = []
  const add = (provider, providerName, model) => {
    const cost = model?.cost
    if (!cost || typeof cost !== 'object') return
    const id = String(model.id || model.model || '').trim()
    if (!provider || !id) return
    const input = Number(cost.input) || 0
    const output = Number(cost.output) || 0
    const cacheRead = Number(cost.cache_read ?? cost.cacheRead) || 0
    const cacheWrite = Number(cost.cache_write ?? cost.cacheWrite) || 0
    models.push({
      provider,
      providerName,
      id,
      name: String(model.name || id),
      canonical: String(model.canonical_model_id || model.canonical || ''),
      cost: { input, output, cacheRead, cacheWrite },
    })
  }

  // 紧凑快照：providers 是 id -> 名称，models 是数组行。
  if (Array.isArray(raw.models) && raw.models.every((row) => Array.isArray(row))) {
    for (const [provider, name] of Object.entries(raw.providers ?? {})) {
      providers[provider] = String(name || provider)
    }
    for (const row of raw.models) {
      const [provider, id, input, output, cacheRead, cacheWrite, canonical] = row
      add(provider, providers[provider] || provider, {
        id,
        canonical_model_id: canonical,
        cost: { input, output, cache_read: cacheRead, cache_write: cacheWrite },
      })
    }
    return {
      version: CATALOG_VERSION,
      source: CATALOG_SOURCE,
      fetchedAt: Number(raw.fetchedAt) || fetchedAt,
      providers,
      models,
    }
  }

  // models.dev 原始 API：顶层 provider -> { name, models: { id -> model } }。
  for (const [provider, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    const providerName = String(entry.name || provider)
    providers[provider] = providerName
    for (const model of Object.values(entry.models ?? {})) add(provider, providerName, model)
  }
  return {
    version: CATALOG_VERSION,
    source: CATALOG_SOURCE,
    fetchedAt,
    providers,
    models,
  }
}

/** 把标准化目录压回紧凑快照，写入本地缓存。 */
export function serializeCatalog(catalog) {
  return {
    version: CATALOG_VERSION,
    source: CATALOG_SOURCE,
    fetchedAt: Number(catalog?.fetchedAt) || 0,
    providers: catalog?.providers ?? {},
    models: (catalog?.models ?? []).map((model) => [
      model.provider,
      model.id,
      model.cost.input,
      model.cost.output,
      model.cost.cacheRead,
      model.cost.cacheWrite,
      model.canonical,
    ]),
  }
}

/**
 * 在目录里为某个平台 / 模型找价格。
 *
 * 匹配顺序：
 * 1. 同平台（含 siliconflow → siliconflow-cn 等别名）的精确 / 归一模型 id；
 * 2. 全目录的精确模型 id（跨平台，标成参考价）；
 * 3. 全目录的归一模型 id（跨平台，标成参考价）。
 *
 * @returns {{provider:string, providerName:string, id:string, name:string, canonical:string,
 *   cost:{input:number,output:number,cacheRead:number,cacheWrite:number},
 *   matchKind:'provider'|'reference', reference:boolean}|null}
 */
export function lookupCatalogModel(catalog, { provider, displayName = '', model }) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const exact = String(model ?? '').trim().toLowerCase()
  const normalized = normalizeModelKey(model)
  if (!exact) return null
  const preferred = providerCandidates(provider, displayName)

  const byExact = (list) => list.find((entry) => entry.id.trim().toLowerCase() === exact)
  const byNormalized = (list) => list.find((entry) => normalizeModelKey(entry.id) === normalized)

  for (const candidate of preferred) {
    const sameProvider = models.filter((entry) => entry.provider === candidate)
    const found = byExact(sameProvider) ?? byNormalized(sameProvider)
    if (found) return { ...found, matchKind: 'provider', reference: false }
  }

  const exactAny = models.filter((entry) => entry.id.trim().toLowerCase() === exact)
  if (exactAny.length > 0) {
    return { ...chooseReference(exactAny, preferred), matchKind: 'reference', reference: true }
  }

  const normalizedAny = models.filter((entry) => normalizeModelKey(entry.id) === normalized)
  if (normalizedAny.length > 0) {
    return { ...chooseReference(normalizedAny, preferred), matchKind: 'reference', reference: true }
  }
  return null
}

/** 跨平台参考价的挑选顺序：优先官方 / 同厂，再按目录顺序稳定选择。 */
function chooseReference(entries, preferred) {
  const official = new Set(['deepseek', 'openai', 'anthropic', 'google', 'alibaba', 'siliconflow-cn', 'siliconflow'])
  let best = entries[0]
  let bestScore = -Infinity
  for (const entry of entries) {
    const vendor = String(entry.canonical ?? '').toLowerCase().split('/')[0] || ''
    let score = 0
    if (preferred.includes(entry.provider)) score += 100
    if (official.has(entry.provider)) score += 20
    if (vendor && entry.provider === vendor) score += 30
    if (entry.cost.input > 0 || entry.cost.output > 0) score += 1
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** 把目录命中转成 prices.json 的模型条目（美元计价，pricer 会按汇率折算）。 */
export function catalogPriceEntry(match, fetchedAt = Date.now()) {
  const rate = { ...match.cost }
  const free = !rate.input && !rate.output && !rate.cacheRead && !rate.cacheWrite
  return {
    currency: 'USD',
    origin: CATALOG_ORIGIN,
    free,
    periods: [{ label: `${CATALOG_SOURCE} · ${match.providerName}`, ranges: [[0, 24]], rate }],
    tiers: [],
    catalogProvider: match.provider,
    catalogProviderName: match.providerName,
    catalogModel: match.id,
    matchKind: match.matchKind,
    fetchedAt,
  }
}

/** 读取一个目录缓存 / 快照文件；失败返回 null。 */
export async function readCatalogFile(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    return normalizeCatalog(raw, { fetchedAt: Number(raw?.fetchedAt) || 0 })
  } catch {
    return null
  }
}

/** 读取随插件发布的快照。 */
export async function readBundledCatalog(file = SNAPSHOT_PATH) {
  return readCatalogFile(file)
}

async function writeCatalogFile(file, catalog) {
  const temporary = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(serializeCatalog(catalog)), 'utf8')
  await rename(temporary, file)
}

/** 从 models.dev 拉取最新目录；网络失败抛错，由调用方回退缓存。 */
export async function fetchModelsDev({ timeoutMs = 20000 } = {}) {
  const response = await fetch(CATALOG_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': 'dsh-billing-statistics/1.13.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
  const raw = await response.json()
  const catalog = normalizeCatalog(raw, { fetchedAt: Date.now() })
  if (catalog.models.length === 0) throw new Error('models.dev 返回了空目录')
  return catalog
}

/**
 * 刷新目录：成功写缓存；失败时用现有缓存 / 内置快照，并把错误原因返回给页面。
 * @returns {Promise<{catalog:object, source:'models.dev'|'cache'|'snapshot', error:string}>}
 */
export async function refreshCatalog({ cacheFile, snapshotFile = SNAPSHOT_PATH, logger } = {}) {
  try {
    const catalog = await fetchModelsDev()
    if (cacheFile) {
      try {
        await writeCatalogFile(cacheFile, catalog)
      } catch (error) {
        logger?.warn?.(`llm-usage: 写入 models.dev 缓存失败：${String(error?.message ?? error)}`)
      }
    }
    return { catalog, source: 'models.dev', error: '' }
  } catch (error) {
    const message = String(error?.message ?? error)
    logger?.warn?.(`llm-usage: 拉取 models.dev 失败，改用缓存：${message}`)
    const cached = cacheFile ? await readCatalogFile(cacheFile) : null
    if (cached) return { catalog: cached, source: 'cache', error: message }
    const bundled = await readBundledCatalog(snapshotFile)
    if (bundled) return { catalog: bundled, source: 'snapshot', error: message }
    throw new Error(`models.dev 不可用，且没有本地价格快照：${message}`)
  }
}

/** 启动时读取缓存；没有缓存则用随插件发布的快照。 */
export async function loadCatalog({ cacheFile, snapshotFile = SNAPSHOT_PATH } = {}) {
  const cached = cacheFile ? await readCatalogFile(cacheFile) : null
  if (cached) return { catalog: cached, source: 'cache', error: '' }
  const bundled = await readBundledCatalog(snapshotFile)
  if (bundled) return { catalog: bundled, source: 'snapshot', error: '' }
  return { catalog: null, source: '', error: '没有可用的 models.dev 价格目录' }
}
