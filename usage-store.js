/**
 * 调用计量的聚合与持久化。
 *
 * 聚合维度是 `provider` × `model`：同一平台同一模型的所有调用累加到一条记录。
 * 为了让「峰谷价」既能记账又能事后按新价格重算，桶做到**小时级**：
 * `hours[YYYY-MM-DD][HH] = { calls, failed, aborted, tokens, cost, peakCost }`，
 * 面板再按天汇总。这样价格同步后可以按每个小时的时段单价重算历史花费。
 *
 * 数据文件：`$DSH_HOME/llm-usage-insights/usage.json`（原子写）。
 * 内存为准、文件为投影：每次调用改内存，短延迟防抖后整体落盘；
 * 写失败只记录日志，不阻塞模型调用。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dayKey, dayKeyBefore, isComplexRule, normalizeUsage, rateAt, SOURCE_NONE } from './pricing.js'

export const FILE_VERSION = 2

/** 空计量。 */
function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, prompt: 0, total: 0 }
}

function emptyTotals() {
  return {
    calls: 0,
    failed: 0,
    aborted: 0,
    tokens: emptyTokens(),
    cost: 0,
    peakCost: 0,
    firstCall: 0,
    lastCall: 0,
  }
}

function emptyRecord(provider, model) {
  return {
    provider,
    model,
    ...emptyTotals(),
    price: { source: SOURCE_NONE, currency: 'CNY' },
    hours: {},
  }
}

function numbersOf(value) {
  const source = value && typeof value === 'object' ? value : {}
  const pick = (key) => {
    const n = Number(source[key])
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  // prompt / total 是由其它字段派生的，读盘时重算，避免旧文件里残留不一致的值。
  const input = pick('input')
  const output = pick('output')
  const cacheRead = pick('cacheRead')
  const cacheWrite = pick('cacheWrite')
  const prompt = input + cacheRead + cacheWrite
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: pick('reasoning'),
    prompt,
    total: prompt + output,
  }
}

function emptyBucket() {
  return { calls: 0, failed: 0, aborted: 0, tokens: emptyTokens(), cost: 0, peakCost: 0 }
}

function addInto(target, delta) {
  target.calls += delta.calls
  target.failed += delta.failed
  target.aborted += delta.aborted
  target.tokens.input += delta.tokens.input
  target.tokens.output += delta.tokens.output
  target.tokens.cacheRead += delta.tokens.cacheRead
  target.tokens.cacheWrite += delta.tokens.cacheWrite
  target.tokens.reasoning += delta.tokens.reasoning
  target.tokens.prompt = target.tokens.input + target.tokens.cacheRead + target.tokens.cacheWrite
  target.tokens.total = target.tokens.prompt + target.tokens.output
  target.cost += delta.cost
  target.peakCost = (target.peakCost ?? 0) + (delta.peakCost ?? 0)
}

/** 把文件里读出的记录补齐成当前形状；坏字段一律按 0 处理，不让整个文件失效。 */
function reviveRecord(key, raw) {
  const provider = String(raw?.provider ?? key.slice(0, Math.max(0, key.indexOf('/'))) ?? '')
  const model = String(raw?.model ?? key.slice(provider.length + 1) ?? '')
  const record = emptyRecord(provider || key, model || '')
  if (!raw || typeof raw !== 'object') return record

  record.calls = Number(raw.calls) || 0
  record.failed = Number(raw.failed) || 0
  record.aborted = Number(raw.aborted) || 0
  record.tokens = numbersOf(raw.tokens)
  record.cost = Number.isFinite(Number(raw.cost)) ? Number(raw.cost) : 0
  record.peakCost = Number.isFinite(Number(raw.peakCost)) ? Number(raw.peakCost) : 0
  record.firstCall = Number(raw.firstCall) || 0
  record.lastCall = Number(raw.lastCall) || 0
  const price = raw.price && typeof raw.price === 'object' ? raw.price : {}
  record.price = {
    source: typeof price.source === 'string' ? price.source : SOURCE_NONE,
    currency: typeof price.currency === 'string' ? price.currency : 'CNY',
  }

  // v2：小时桶
  if (raw.hours && typeof raw.hours === 'object') {
    for (const [day, dayBuckets] of Object.entries(raw.hours)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !dayBuckets || typeof dayBuckets !== 'object') continue
      for (const [hour, entry] of Object.entries(dayBuckets)) {
        if (!/^\d{2}$/.test(hour) || !entry || typeof entry !== 'object') continue
        const bucket = emptyBucket()
        bucket.calls = Number(entry.calls) || 0
        bucket.failed = Number(entry.failed) || 0
        bucket.aborted = Number(entry.aborted) || 0
        bucket.tokens = numbersOf(entry.tokens)
        bucket.cost = Number.isFinite(Number(entry.cost)) ? Number(entry.cost) : 0
        bucket.peakCost = Number.isFinite(Number(entry.peakCost)) ? Number(entry.peakCost) : bucket.cost
        record.hours[day] = record.hours[day] ?? {}
        record.hours[day][hour] = bucket
      }
    }
  }

  // v1：按天桶 → 迁到小时桶，放进正午（时段归属未知，按峰时记，避免夸大谷时折扣）。
  if (raw.daily && typeof raw.daily === 'object' && Object.keys(record.hours).length === 0) {
    for (const [day, entry] of Object.entries(raw.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entry || typeof entry !== 'object') continue
      const bucket = emptyBucket()
      bucket.calls = Number(entry.calls) || 0
      bucket.failed = Number(entry.failed) || 0
      bucket.aborted = Number(entry.aborted) || 0
      bucket.tokens = numbersOf(entry.tokens)
      bucket.cost = Number.isFinite(Number(entry.cost)) ? Number(entry.cost) : 0
      bucket.peakCost = bucket.cost
      record.hours[day] = { '12': bucket }
    }
  }

  return record
}

/**
 * @param {object} options
 * @param {string} options.directory 数据目录
 * @param {number} options.retainDays 保留天数（1 起）
 * @param {object} options.pricer createPricer() 返回的计价器
 * @param {() => Array<{ provider: string, displayName?: string }>} [options.listProviders]
 * @param {boolean} [options.showCost]
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 */
export class UsageStore {
  constructor(options) {
    this.directory = options.directory
    this.file = join(options.directory, 'usage.json')
    this.retainDays = Math.max(1, Math.floor(Number(options.retainDays) || 90))
    this.pricer = options.pricer
    this.listProviders = options.listProviders ?? (() => [])
    this.showCost = options.showCost !== false
    this.logger = options.logger
    /** @type {Map<string, object>} */
    this.records = new Map()
    this.updatedAt = 0
    this.loadedAt = 0
    this.migrated = false
    this.dirty = false
    this.flushTimer = null
    this.flushChain = Promise.resolve()
    this.closed = false
  }

  /** 价格表更新后换计价器并重算历史（含阶梯价的模型保持原值）。 */
  setPricer(pricer) {
    this.pricer = pricer
    return this.reprice()
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const version = Number(parsed?.version) || 0
      const rawRecords = parsed && typeof parsed.records === 'object' && parsed.records ? parsed.records : {}
      for (const [key, raw] of Object.entries(rawRecords)) {
        const record = reviveRecord(key, raw)
        if (record.calls === 0 && Object.keys(record.hours).length === 0) continue
        this.records.set(key, record)
      }
      this.updatedAt = Number(parsed?.updatedAt) || 0
      if (version > 0 && version < FILE_VERSION) {
        this.migrated = true
        this.dirty = true
        this.logger?.info?.(`llm-usage: 数据文件从 v${version} 迁移到 v${FILE_VERSION}（按小时分桶）`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn(`llm-usage: 读取历史数据失败，按空数据启动：${String(error?.message ?? error)}`)
      }
    }
    this.loadedAt = Date.now()
    this.prune()
  }

  /** 删掉超出保留期的小时桶，并重算总计，避免总量随裁剪漂移。 */
  prune() {
    const cutoff = dayKeyBefore(this.retainDays - 1)
    let removed = 0
    for (const record of this.records.values()) {
      for (const day of Object.keys(record.hours)) {
        if (day < cutoff) {
          delete record.hours[day]
          removed += 1
        }
      }
      if (Object.keys(record.hours).length === 0) {
        record.calls = 0
        record.failed = 0
        record.aborted = 0
        record.tokens = emptyTokens()
        record.cost = 0
        record.peakCost = 0
      }
    }
    if (removed > 0) {
      for (const record of this.records.values()) this.recount(record)
      this.dirty = true
      this.scheduleFlush()
    }
  }

  /** 用小时桶重算一条记录的总计（calls/tokens/cost/首末调用时间）。 */
  recount(record) {
    const totals = emptyTotals()
    totals.firstCall = record.firstCall
    totals.lastCall = record.lastCall
    for (const [day, buckets] of Object.entries(record.hours)) {
      for (const [hour, bucket] of Object.entries(buckets)) {
        addInto(totals, bucket)
        if (totals.firstCall === 0 && bucket.calls > 0) {
          totals.firstCall = Date.parse(`${day}T${hour}:00:00+08:00`) || totals.firstCall
        }
        const at = Date.parse(`${day}T${hour}:59:59+08:00`)
        if (Number.isFinite(at) && at > totals.lastCall) totals.lastCall = at
      }
    }
    record.calls = totals.calls
    record.failed = totals.failed
    record.aborted = totals.aborted
    record.tokens = totals.tokens
    record.cost = totals.cost
    record.peakCost = totals.peakCost
  }

  /**
   * 记录一次模型请求尝试。
   * @param {object} input
   * @param {string} input.provider
   * @param {string} input.model
   * @param {'ok'|'failed'|'aborted'} [input.outcome]
   * @param {object} [input.usage] TokenUsage
   * @param {number} [input.at] 时间戳
   */
  recordCall({ provider, model, outcome = 'ok', usage, at = Date.now() }) {
    if (this.closed) return
    const providerId = String(provider || 'unknown')
    const modelId = String(model || 'unknown')
    const key = `${providerId}/${modelId}`
    let record = this.records.get(key)
    if (!record) {
      record = emptyRecord(providerId, modelId)
      this.records.set(key, record)
    }
    const tokens = normalizeUsage(usage)
    const promptTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
    const priced = this.pricer?.priceFor(providerId, modelId, at, promptTokens)
    const rate = priced?.rate ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const source = priced?.rule?.source ?? SOURCE_NONE
    const currency = priced?.rule?.currency ?? 'CNY'
    const cost =
      (tokens.inputTokens * rate.input +
        tokens.outputTokens * rate.output +
        tokens.cacheReadTokens * rate.cacheRead +
        tokens.cacheWriteTokens * rate.cacheWrite) /
      1_000_000
    const delta = {
      calls: 1,
      failed: outcome === 'failed' ? 1 : 0,
      aborted: outcome === 'aborted' ? 1 : 0,
      tokens: {
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cacheRead: tokens.cacheReadTokens,
        cacheWrite: tokens.cacheWriteTokens,
        reasoning: tokens.reasoningTokens,
      },
      cost,
      peakCost: priced?.peak ? cost : 0,
    }

    if (record.calls === 0) record.firstCall = at
    record.lastCall = at
    record.price = { source, currency }
    addInto(record, delta)

    const day = dayKey(at)
    const hour = String(new Date(at + 8 * 3600 * 1000).getUTCHours()).padStart(2, '0')
    const buckets = (record.hours[day] = record.hours[day] ?? {})
    const bucket = (buckets[hour] = buckets[hour] ?? emptyBucket())
    addInto(bucket, delta)

    this.updatedAt = at
    this.dirty = true
    this.scheduleFlush()
  }

  /** 价格表变化后，按当前规则重算所有小时桶的花费（阶梯价模型跳过，保留原值）。 */
  reprice() {
    if (!this.pricer) return
    let changed = 0
    for (const record of this.records.values()) {
      const rule = this.pricer.resolve(record.provider, record.model)
      if (isComplexRule(rule) && (rule.tiers?.length ?? 0) > 0) continue
      let touched = 0
      for (const [day, buckets] of Object.entries(record.hours)) {
        for (const [hour, bucket] of Object.entries(buckets)) {
          if (bucket.tokens.total === 0 && bucket.calls === 0) continue
          const at = Date.parse(`${day}T${hour}:00:00+08:00`)
          if (!Number.isFinite(at)) continue
          const promptTokens = bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite
          const picked = rateAt(rule, at, promptTokens)
          const cost =
            (bucket.tokens.input * picked.rate.input +
              bucket.tokens.output * picked.rate.output +
              bucket.tokens.cacheRead * picked.rate.cacheRead +
              bucket.tokens.cacheWrite * picked.rate.cacheWrite) /
            1_000_000
          bucket.cost = cost
          bucket.peakCost = picked.peak ? cost : 0
          touched += 1
        }
      }
      if (touched > 0) {
        this.recount(record)
        record.price = { source: rule.source, currency: rule.currency ?? 'CNY' }
        changed += 1
      }
    }
    if (changed > 0) {
      this.updatedAt = Date.now()
      this.dirty = true
      this.scheduleFlush()
    }
    return changed
  }

  scheduleFlush() {
    if (this.closed || this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 1500)
    this.flushTimer.unref?.()
  }

  /** 立即把内存投影写入磁盘；并发调用共享同一条写链。 */
  flush() {
    if (this.closed) return this.flushChain
    this.flushChain = this.flushChain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      const payload = {
        version: FILE_VERSION,
        updatedAt: this.updatedAt,
        records: Object.fromEntries(this.records),
      }
      const text = JSON.stringify(payload)
      const temporary = `${this.file}.tmp`
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, this.file)
      } catch (error) {
        this.dirty = true
        this.logger?.warn(`llm-usage: 写入数据文件失败：${String(error?.message ?? error)}`)
      }
    })
    return this.flushChain
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // close() 之后 flush() 会直接返回，所以这里先把标记复位再写一次。
    this.closed = false
    await this.flush()
    this.closed = true
  }

  async reset() {
    this.records.clear()
    this.updatedAt = Date.now()
    this.dirty = true
    await this.flush()
  }

  /** 平台展示名：优先取 llm 目录里的 displayName，其次用 provider id。 */
  platformNames() {
    const names = {}
    try {
      for (const entry of this.listProviders() || []) {
        if (!entry || typeof entry.provider !== 'string') continue
        if (typeof entry.displayName === 'string' && entry.displayName.trim()) {
          names[entry.provider] = entry.displayName.trim()
        }
      }
    } catch {
      // 目录暂时不可读时退回 provider id，不影响统计。
    }
    return names
  }

  /** 已用过的 provider → 出现过的模型 id 列表（官网通用解析时用来定位模型名）。 */
  providerModels() {
    const table = {}
    for (const record of this.records.values()) {
      const provider = record.provider
      const model = record.model
      if (!provider || !model) continue
      table[provider] = table[provider] ?? new Set()
      table[provider].add(model)
    }
    const result = {}
    for (const [provider, set] of Object.entries(table)) result[provider] = [...set]
    return result
  }

  /**
   * 构造面板 payload。
   * @param {{ days?: number }} [options]
   */
  summary({ days = 7 } = {}) {
    const names = this.platformNames()
    const now = Date.now()
    const from = days > 0 ? dayKeyBefore(days - 1, now) : ''
    const groups = new Map()

    const ensureGroup = (provider) => {
      let group = groups.get(provider)
      if (!group) {
        group = {
          provider,
          displayName: names[provider] ?? provider,
          totals: emptyTotals(),
          models: [],
        }
        groups.set(provider, group)
      }
      return group
    }

    for (const record of this.records.values()) {
      const group = ensureGroup(record.provider)
      const totals = emptyTotals()
      const daily = []
      let daysWithData = 0
      for (const [day, buckets] of Object.entries(record.hours)) {
        if (from !== '' && day < from) continue
        const dayTotals = emptyTotals()
        for (const bucket of Object.values(buckets)) addInto(dayTotals, bucket)
        if (dayTotals.calls === 0 && dayTotals.tokens.total === 0) continue
        addInto(totals, dayTotals)
        daily.push({
          day,
          calls: dayTotals.calls,
          failed: dayTotals.failed,
          aborted: dayTotals.aborted,
          tokens: { ...dayTotals.tokens },
          cost: dayTotals.cost,
          peakCost: dayTotals.peakCost,
        })
        daysWithData += 1
      }
      if (daysWithData === 0) continue
      daily.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      addInto(group.totals, totals)
      const price = this.pricer?.describe(record.provider, record.model) ?? {
        source: SOURCE_NONE,
        currency: 'CNY',
        periods: [],
        tiers: [],
      }
      group.models.push({
        provider: record.provider,
        model: record.model,
        calls: totals.calls,
        failed: totals.failed,
        aborted: totals.aborted,
        tokens: { ...totals.tokens },
        cost: totals.cost,
        peakCost: totals.peakCost,
        costKnown: price.source !== SOURCE_NONE,
        price,
        firstCall: record.firstCall,
        lastCall: record.lastCall,
        daily,
      })
    }

    const platforms = [...groups.values()]
      .filter((group) => group.models.length > 0)
      .sort((a, b) => b.totals.calls - a.totals.calls || a.provider.localeCompare(b.provider))
    for (const group of platforms) {
      group.models.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
      group.costKnown = group.models.some((model) => model.costKnown)
    }

    const overall = emptyTotals()
    for (const group of platforms) addInto(overall, group.totals)

    return {
      generatedAt: now,
      updatedAt: this.updatedAt || this.loadedAt,
      days,
      from: from || null,
      showCost: this.showCost,
      retainDays: this.retainDays,
      platforms,
      totals: {
        calls: overall.calls,
        failed: overall.failed,
        aborted: overall.aborted,
        tokens: { ...overall.tokens },
        cost: overall.cost,
        peakCost: overall.peakCost,
        offPeakCost: Math.max(0, overall.cost - overall.peakCost),
        platforms: platforms.length,
        models: platforms.reduce((sum, group) => sum + group.models.length, 0),
      },
    }
  }

  /**
   * 单个模型的按小时明细（供页面二次展开使用）。
   * 只返回有调用的时段，按日期、小时升序。
   * @param {{ provider?: string, model?: string, days?: number }} [options]
   */
  modelDetail({ provider, model, days = 0 } = {}) {
    const providerId = String(provider || '')
    const modelId = String(model || '')
    const windowDays = Math.max(0, Number(days) || 0)
    const from = windowDays > 0 ? dayKeyBefore(windowDays - 1, Date.now()) : ''
    const totals = emptyTotals()
    const hours = []
    const record = this.records.get(`${providerId}/${modelId}`)
    if (record) {
      for (const [day, buckets] of Object.entries(record.hours)) {
        if (from !== '' && day < from) continue
        for (const [hour, bucket] of Object.entries(buckets)) {
          if (!bucket || (bucket.calls === 0 && bucket.tokens?.total === 0)) continue
          addInto(totals, bucket)
          hours.push({
            day,
            hour: Number(hour),
            calls: bucket.calls,
            failed: bucket.failed,
            aborted: bucket.aborted,
            tokens: { ...bucket.tokens },
            cost: bucket.cost,
            peakCost: bucket.peakCost,
          })
        }
      }
      hours.sort((a, b) => (a.day === b.day ? a.hour - b.hour : a.day < b.day ? -1 : 1))
    }
    return {
      provider: providerId,
      model: modelId,
      windowDays,
      from: from || null,
      hours,
      totals,
    }
  }
}
