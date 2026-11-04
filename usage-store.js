/**
 * 调用计量的聚合与持久化。
 *
 * 聚合维度是 `provider` × `model`：同一平台同一模型的所有调用累加到一条记录。
 * 为了让「峰谷价」既能记账又能事后按新价格重算，桶做到**小时级**：
 * `hours[YYYY-MM-DD][HH] = { calls, failed, aborted, tokens, cost, peakCost }`，
 * 面板再按天汇总。这样价格同步后可以按每个小时的时段单价重算历史花费。
 *
 * 数据文件：`$DSH_HOME/llm-usage-insights/usage.json`（历史兼容目录，原子写）。
 * 内存为准、文件为投影：每次调用改内存，短延迟防抖后整体落盘；
 * 写失败只记录日志，不阻塞模型调用。
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  beijingParts,
  dayKey,
  dayKeyBefore,
  isComplexRule,
  normalizeOffsetHours,
  normalizeUsage,
  offsetZone,
  rateAt,
  SOURCE_NONE,
} from './pricing.js'

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
    // 月度汇总不随小时桶裁剪，用来支撑「年 / 全部」的长期统计。
    months: {},
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

/**
 * 金额统一保留 6 位小数（0.000001 元）。
 * 计量本身用完整精度算，落账时收敛到 6 位，避免浮点尾数（0.1+0.2 那种）影响对账；
 * 报表（HTML / CSV）同样按 6 位输出，这是账本可追溯的最高精度。
 */
function roundMoney(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0
}

/** 合并一份桶集合（小时/月）到目标集合：逐字段取大，避免两实例互相覆盖时重复计数。 */
function mergeBucketsInto(target, incoming, keyPattern) {
  for (const [slot, bucket] of Object.entries(incoming ?? {})) {
    if (!keyPattern.test(slot) || !bucket || typeof bucket !== 'object') continue
    const current = (target[slot] = target[slot] ?? emptyBucket())
    for (const key of ['calls', 'failed', 'aborted', 'cost', 'peakCost']) {
      current[key] = Math.max(current[key] ?? 0, bucket[key] ?? 0)
    }
    current.cost = roundMoney(current.cost)
    current.peakCost = roundMoney(current.peakCost)
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total']) {
      current.tokens[key] = Math.max(current.tokens[key] ?? 0, bucket.tokens?.[key] ?? 0)
    }
    current.tokens.prompt = current.tokens.input + current.tokens.cacheRead + current.tokens.cacheWrite
    current.tokens.total = current.tokens.prompt + current.tokens.output
  }
}

/** 合并另一份记录的小时桶与月桶：逐字段取大（两实例互相覆盖时宁可少算，也不重复计数）。 */
function mergeMaxInto(target, incoming) {
  for (const [day, buckets] of Object.entries(incoming.hours ?? {})) {
    const mine = (target.hours[day] = target.hours[day] ?? {})
    for (const [hour, bucket] of Object.entries(buckets)) {
      const current = (mine[hour] = mine[hour] ?? emptyBucket())
      for (const key of ['calls', 'failed', 'aborted', 'cost', 'peakCost']) {
        current[key] = Math.max(current[key] ?? 0, bucket[key] ?? 0)
      }
      current.cost = roundMoney(current.cost)
      current.peakCost = roundMoney(current.peakCost)
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total']) {
        current.tokens[key] = Math.max(current.tokens[key] ?? 0, bucket.tokens?.[key] ?? 0)
      }
      current.tokens.prompt = current.tokens.input + current.tokens.cacheRead + current.tokens.cacheWrite
      current.tokens.total = current.tokens.prompt + current.tokens.output
    }
  }
  target.months = target.months ?? {}
  mergeBucketsInto(target.months, incoming.months, /^\d{4}-\d{2}$/)
  if (incoming.firstCall > 0) {
    target.firstCall = target.firstCall > 0 ? Math.min(target.firstCall, incoming.firstCall) : incoming.firstCall
  }
  target.lastCall = Math.max(target.lastCall ?? 0, incoming.lastCall ?? 0)
}

/** 文件锁的等待节奏（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  record.cost = roundMoney(raw.cost)
  record.peakCost = roundMoney(raw.peakCost)
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
        bucket.cost = roundMoney(entry.cost)
        bucket.peakCost = Number.isFinite(Number(entry.peakCost)) ? roundMoney(entry.peakCost) : bucket.cost
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
      bucket.cost = roundMoney(entry.cost)
      bucket.peakCost = bucket.cost
      record.hours[day] = { '12': bucket }
    }
  }

  // 月汇总：长期保留（不随小时桶裁剪），用于「年 / 全部」视图。
  if (raw.months && typeof raw.months === 'object') {
    for (const [month, entry] of Object.entries(raw.months)) {
      if (!/^\d{4}-\d{2}$/.test(month) || !entry || typeof entry !== 'object') continue
      const bucket = emptyBucket()
      bucket.calls = Number(entry.calls) || 0
      bucket.failed = Number(entry.failed) || 0
      bucket.aborted = Number(entry.aborted) || 0
      bucket.tokens = numbersOf(entry.tokens)
      bucket.cost = roundMoney(entry.cost)
      bucket.peakCost = Number.isFinite(Number(entry.peakCost)) ? roundMoney(entry.peakCost) : bucket.cost
      record.months[month] = bucket
    }
  }
  // 旧文件只有小时桶：用它补出月汇总，升级后即可按年查看。
  if (Object.keys(record.months).length === 0) {
    for (const [day, buckets] of Object.entries(record.hours)) {
      const month = day.slice(0, 7)
      const target = (record.months[month] = record.months[month] ?? emptyBucket())
      for (const bucket of Object.values(buckets)) addInto(target, bucket)
      target.cost = roundMoney(target.cost)
      target.peakCost = roundMoney(target.peakCost)
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
    this.retainDays = Math.max(1, Math.floor(Number(options.retainDays) || 30))
    this.utcOffsetHours = normalizeOffsetHours(options.utcOffsetHours)
    this.lockFile = join(options.directory, 'usage.lock')
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
    this.loadPromise = null
    this.readOnly = false
    this.lastFlushOk = true
  }

  /** load() 只会执行一次；流钩子记账前可以先等这个 Promise。 */
  load() {
    if (!this.loadPromise) this.loadPromise = this.loadOnce()
    return this.loadPromise
  }

  whenReady() {
    return this.loadPromise ?? Promise.resolve()
  }

  /** 价格表更新后换计价器并重算历史（含阶梯价的模型保持原值）。 */
  setPricer(pricer) {
    this.pricer = pricer
    return this.reprice()
  }

  /**
   * 历史文件损坏时先改名备份，再按空数据启动；绝不直接把它覆盖成空文件。
   * 如果连改名都失败，则进入只读模式，宁可本次不落盘也不销毁证据。
   */
  async quarantineBrokenFile(error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${this.file}.corrupt-${stamp}`
    try {
      await rename(this.file, backup)
      this.logger?.warn?.(`llm-usage: 历史数据损坏，已备份到 ${backup}，本次按空数据启动：${String(error?.message ?? error)}`)
    } catch (renameError) {
      this.readOnly = true
      this.logger?.error?.(
        `llm-usage: 历史数据损坏且无法备份，已暂停写入以免覆盖原文件；请检查 ${this.file}：${String(renameError?.message ?? renameError)}`,
      )
    }
  }

  async loadOnce() {
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
      if (error?.code !== 'ENOENT') await this.quarantineBrokenFile(error)
    }
    this.loadedAt = Date.now()
    this.prune()
    // 同一数据目录被两个实例同时打开时，两个进程都各自记账：写盘靠锁互斥，
    // 但计数只能「逐字段取大」合并，所以这里明确告警一次。
    if (!(await this.lockIsStale())) {
      this.logger?.warn?.('llm-usage: 检测到另一个实例正在使用同一数据目录，同时写入的调用可能被少算（建议只开一个窗口）')
    }
  }

  /** 删掉超出保留期的小时桶（月汇总永久保留），再按月汇总重算总计。 */
  prune() {
    const cutoff = dayKeyBefore(this.retainDays - 1, Date.now(), this.utcOffsetHours)
    let removed = 0
    for (const record of this.records.values()) {
      for (const day of Object.keys(record.hours)) {
        if (day < cutoff) {
          delete record.hours[day]
          removed += 1
        }
      }
    }
    if (removed > 0) {
      for (const record of this.records.values()) this.recount(record)
      this.dirty = true
      this.scheduleFlush()
    }
  }

  /** 用月汇总重算一条记录的总计（calls/tokens/cost/首末调用时间）；旧数据没有月桶时退回小时桶。 */
  recount(record) {
    const totals = emptyTotals()
    totals.firstCall = record.firstCall
    totals.lastCall = record.lastCall
    const monthly = Object.values(record.months ?? {})
    if (monthly.length > 0) {
      for (const bucket of monthly) addInto(totals, bucket)
    } else {
      for (const [day, buckets] of Object.entries(record.hours)) {
        for (const [hour, bucket] of Object.entries(buckets)) {
          addInto(totals, bucket)
          const zone = offsetZone(this.utcOffsetHours)
          if (totals.firstCall === 0 && bucket.calls > 0) {
            totals.firstCall = Date.parse(`${day}T${hour}:00:00${zone}`) || totals.firstCall
          }
          const at = Date.parse(`${day}T${hour}:59:59${zone}`)
          if (Number.isFinite(at) && at > totals.lastCall) totals.lastCall = at
        }
      }
    }
    record.calls = totals.calls
    record.failed = totals.failed
    record.aborted = totals.aborted
    record.tokens = totals.tokens
    record.cost = roundMoney(totals.cost)
    record.peakCost = roundMoney(totals.peakCost)
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
    const cost = roundMoney(
      (tokens.inputTokens * rate.input +
        tokens.outputTokens * rate.output +
        tokens.cacheReadTokens * rate.cacheRead +
        tokens.cacheWriteTokens * rate.cacheWrite) /
        1_000_000,
    )
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
    record.cost = roundMoney(record.cost)
    record.peakCost = roundMoney(record.peakCost)

    const day = dayKey(at, this.utcOffsetHours)
    const hour = String(beijingParts(at, this.utcOffsetHours).hour).padStart(2, '0')
    const buckets = (record.hours[day] = record.hours[day] ?? {})
    const bucket = (buckets[hour] = buckets[hour] ?? emptyBucket())
    addInto(bucket, delta)
    bucket.cost = roundMoney(bucket.cost)
    bucket.peakCost = roundMoney(bucket.peakCost)

    // 月汇总：与小时桶同一份 delta，长期保留。
    const month = day.slice(0, 7)
    record.months = record.months ?? {}
    const monthly = (record.months[month] = record.months[month] ?? emptyBucket())
    addInto(monthly, delta)
    monthly.cost = roundMoney(monthly.cost)
    monthly.peakCost = roundMoney(monthly.peakCost)

    this.updatedAt = at
    this.dirty = true
    this.scheduleFlush()
  }

  /** 价格表变化后，按当前规则重算所有小时桶的花费（阶梯价模型跳过，保留原值）。 */
  reprice(keys = null) {
    if (!this.pricer) return
    let changed = 0
    const trusted = (this.priceTrusted = this.priceTrusted ?? new Set())
    for (const [key, record] of this.records) {
      if (keys && !keys.has(key)) continue
      const rule = this.pricer.resolve(record.provider, record.model)
      // 没价可依的模型保持原值，避免重算时按 0 元把历史花费清掉。
      if (rule.source === SOURCE_NONE) continue
      if (isComplexRule(rule) && (rule.tiers?.length ?? 0) > 0) continue
      let touched = 0
      for (const [day, buckets] of Object.entries(record.hours)) {
        for (const [hour, bucket] of Object.entries(buckets)) {
          if (bucket.tokens.total === 0 && bucket.calls === 0) continue
          const at = Date.parse(`${day}T${hour}:00:00${offsetZone(this.utcOffsetHours)}`)
          if (!Number.isFinite(at)) continue
          const promptTokens = bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite
          const picked = rateAt(rule, at, promptTokens, this.utcOffsetHours)
          const cost = roundMoney(
            (bucket.tokens.input * picked.rate.input +
              bucket.tokens.output * picked.rate.output +
              bucket.tokens.cacheRead * picked.rate.cacheRead +
              bucket.tokens.cacheWrite * picked.rate.cacheWrite) /
              1_000_000,
          )
          const nextPeak = picked.peak ? cost : 0
          // 月汇总同步调整增量，保证「年 / 全部」和历史小时桶一致；
          // 已被裁剪、只剩月汇总的月份不受影响。
          const monthly = record.months?.[day.slice(0, 7)]
          if (monthly) {
            monthly.cost = roundMoney(monthly.cost + (cost - bucket.cost))
            monthly.peakCost = roundMoney(monthly.peakCost + (nextPeak - (bucket.peakCost ?? 0)))
          }
          bucket.cost = cost
          bucket.peakCost = nextPeak
          touched += 1
        }
      }
      if (touched > 0) {
        this.recount(record)
        record.price = { source: rule.source, currency: rule.currency ?? 'CNY' }
        trusted.add(key)
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
      if (this.readOnly) {
        this.dirty = true
        this.lastFlushOk = false
        if (!this.readOnlyWarned) {
          this.readOnlyWarned = true
          this.logger?.warn?.('llm-usage: 数据文件损坏且未能备份，已暂停写盘；修复/移走原文件后重启插件即可恢复')
        }
        return
      }
      this.dirty = false
      let locked = false
      let temporary = ''
      this.lastFlushOk = false
      try {
        locked = await this.acquireLock()
        if (!locked) {
          // 另一个实例正握着锁：这次不写盘，保留脏标记，稍后重试，避免覆盖它刚写入的数据。
          this.dirty = true
          this.scheduleFlush()
          return
        }
        // reset() 必须真的清空：跳过合并，否则盘上旧数据会被并回来。
        if (!this.skipMerge) await this.mergeFromDisk()
        this.skipMerge = false
        // 重算过价格的记录：合并盘上数据后要按合并后的 token 再算一次，
        // 否则盘上的旧价（取大合并）会把刚降下来的花费顶回去。
        if (this.priceTrusted?.size) this.reprice(new Set(this.priceTrusted))
        const payload = {
          version: FILE_VERSION,
          updatedAt: this.updatedAt,
          records: Object.fromEntries(this.records),
        }
        temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(temporary, JSON.stringify(payload), 'utf8')
        await rename(temporary, this.file)
        temporary = ''
        this.lastFlushOk = true
        this.priceTrusted?.clear()
      } catch (error) {
        this.dirty = true
        this.logger?.warn(`llm-usage: 写入数据文件失败：${String(error?.message ?? error)}`)
      } finally {
        if (temporary) await unlink(temporary).catch(() => {})
        if (locked) await this.releaseLock()
      }
    })
    return this.flushChain
  }

  /**
   * 拿 `usage.lock` 独占锁（短临界区，写完就释放）。
   * 进程被硬杀会留下锁文件，靠 pid 存活探测 + 60 秒心跳超时判定为残留并清掉。
   * @param {number} [waitMs]
   */
  async acquireLock(waitMs = 3000) {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      try {
        // 用带 wx 的单次写创建锁：比 open + write 少一个“文件已存在但内容为空”的窗口。
        await writeFile(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (error) {
        if (error?.code !== 'EEXIST') return false
        if (await this.lockIsStale()) {
          await unlink(this.lockFile).catch(() => {})
          continue
        }
        if (Date.now() >= deadline) {
          if (!this.lockWarned) {
            this.lockWarned = true
            this.logger?.warn?.('llm-usage: 另一个实例正持有数据文件锁，本次暂不写盘，稍后重试')
          }
          return false
        }
        await sleep(80)
      }
    }
  }

  /**
   * 锁是否已经失效（属主进程已退出 / 超过 60 秒没动静 / 空锁但已超过创建宽限）。
   * 空/半截锁在刚创建的两秒内视为“正在写”，避免两个进程同时看到空文件后互删锁。
   */
  async lockIsStale() {
    let info
    try {
      info = await stat(this.lockFile)
    } catch (error) {
      return error?.code === 'ENOENT' ? true : false
    }
    let raw
    try {
      raw = JSON.parse(await readFile(this.lockFile, 'utf8'))
    } catch {
      return Date.now() - Number(info.mtimeMs || 0) > 2000
    }
    const pid = Number(raw?.pid)
    const at = Number(raw?.at) || 0
    if (!pid) return Date.now() - Number(info.mtimeMs || 0) > 2000
    // 同一个进程里的另一个 store 也是活锁，不能因为 pid 相同就删掉。
    if (pid === process.pid) return false
    if (Date.now() - at > 60_000) return true
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  async releaseLock() {
    await unlink(this.lockFile).catch(() => {})
  }

  /** 把盘上其它实例写过的桶并进内存（逐字段取大）。 */
  async mergeFromDisk() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return
      // 盘上文件在运行中被改坏：暂停写入，别用内存覆盖掉最后的证据。
      this.readOnly = true
      this.logger?.warn?.(`llm-usage: 盘上数据文件损坏，已暂停写入以免覆盖：${String(error?.message ?? error)}`)
      throw error
    }
    const rawRecords = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {}
    for (const [key, raw] of Object.entries(rawRecords)) {
      const incoming = reviveRecord(key, raw)
      const current = this.records.get(key)
      if (!current) {
        this.records.set(key, incoming)
        continue
      }
      mergeMaxInto(current, incoming)
      this.recount(current)
    }
    this.updatedAt = Math.max(this.updatedAt, Number(parsed?.updatedAt) || 0)
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
    const previousRecords = new Map(this.records)
    const previousUpdatedAt = this.updatedAt
    this.skipMerge = true
    this.records.clear()
    this.updatedAt = Date.now()
    this.dirty = true
    this.lastFlushOk = false
    await this.flush()
    if (!this.lastFlushOk) {
      // 清空没有真正落盘时恢复内存，避免页面显示“已清空”而磁盘仍是旧数据。
      this.records = previousRecords
      this.updatedAt = previousUpdatedAt
      this.dirty = false
      this.skipMerge = false
      throw new Error('无法写入数据文件，重置未生效')
    }
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

  /**
   * 某一天按平台汇总，供「官方账单对齐」窗口使用。
   * 只读小时桶，不改变任何统计口径；没有记录的日期返回空的 providers。
   * @param {string} day YYYY-MM-DD
   */
  dayTotals(day) {
    const key = String(day ?? '')
    const names = this.platformNames()
    const groups = new Map()

    const ensureGroup = (provider) => {
      let group = groups.get(provider)
      if (!group) {
        group = {
          provider,
          displayName: names[provider] ?? provider,
          calls: 0,
          failed: 0,
          aborted: 0,
          tokens: emptyTokens(),
          cost: 0,
          peakCost: 0,
          models: 0,
        }
        groups.set(provider, group)
      }
      return group
    }

    for (const record of this.records.values()) {
      const buckets = record.hours?.[key]
      if (!buckets) continue
      const totals = emptyTotals()
      for (const bucket of Object.values(buckets)) addInto(totals, bucket)
      if (totals.calls === 0 && totals.tokens.total === 0) continue
      const group = ensureGroup(record.provider)
      group.calls += totals.calls
      group.failed += totals.failed
      group.aborted += totals.aborted
      for (const name of Object.keys(group.tokens)) group.tokens[name] += totals.tokens[name]
      group.cost += totals.cost
      group.peakCost += totals.peakCost
      group.models += 1
    }

    const providers = [...groups.values()]
      .map((group) => ({
        ...group,
        cost: roundMoney(group.cost),
        peakCost: roundMoney(group.peakCost),
      }))
      .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider))
    const overall = {
      calls: providers.reduce((sum, entry) => sum + entry.calls, 0),
      failed: providers.reduce((sum, entry) => sum + entry.failed, 0),
      aborted: providers.reduce((sum, entry) => sum + entry.aborted, 0),
      tokens: emptyTokens(),
      cost: 0,
      peakCost: 0,
      platforms: providers.length,
    }
    for (const entry of providers) {
      for (const name of Object.keys(overall.tokens)) overall.tokens[name] += entry.tokens[name]
      overall.cost += entry.cost
      overall.peakCost += entry.peakCost
    }
    overall.cost = roundMoney(overall.cost)
    overall.peakCost = roundMoney(overall.peakCost)

    return {
      day: key,
      generatedAt: Date.now(),
      utcOffsetHours: this.utcOffsetHours,
      providers,
      totals: overall,
    }
  }

  /** 已用过的 provider → 出现过的模型 id 列表（models.dev 检索与人工导入表格使用）。 */
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
   * @param {{ days?: number, year?: number }} [options]
   * days>0：按天视图（小时桶）；year>0：该年按月视图；days=0 且无 year：全部按年视图。
   */
  summary({ days = 7, year = 0 } = {}) {
    const names = this.platformNames()
    const now = Date.now()
    const yearNum = Math.max(0, Math.floor(Number(year) || 0))
    const allTime = yearNum === 0 && !(Number(days) > 0)
    const from = !yearNum && Number(days) > 0 ? dayKeyBefore(days - 1, now, this.utcOffsetHours) : ''
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

    const rowOf = (totals, extra) => ({
      ...extra,
      calls: totals.calls,
      failed: totals.failed,
      aborted: totals.aborted,
      tokens: { ...totals.tokens },
      cost: roundMoney(totals.cost),
      peakCost: roundMoney(totals.peakCost),
    })

    /** 全站年份列表：只依赖月汇总，供顶部年份切换使用。 */
    const yearTotals = new Map()
    for (const record of this.records.values()) {
      for (const [month, bucket] of Object.entries(record.months ?? {})) {
        const y = month.slice(0, 4)
        const totals = yearTotals.get(y) ?? emptyTotals()
        addInto(totals, bucket)
        yearTotals.set(y, totals)
      }
    }
    const years = [...yearTotals.entries()]
      .map(([y, totals]) => rowOf(totals, { year: y }))
      .sort((a, b) => (a.year < b.year ? 1 : a.year > b.year ? -1 : 0))

    /** 选中某年时，全站按月汇总（页面据此直接列出 12 个月）。 */
    const monthTotals = new Map()
    if (yearNum > 0) {
      const prefix = `${yearNum}-`
      for (const record of this.records.values()) {
        for (const [month, bucket] of Object.entries(record.months ?? {})) {
          if (!month.startsWith(prefix)) continue
          const totals = monthTotals.get(month) ?? emptyTotals()
          addInto(totals, bucket)
          monthTotals.set(month, totals)
        }
      }
    }
    const months = [...monthTotals.entries()]
      .map(([month, totals]) => rowOf(totals, { month }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))

    for (const record of this.records.values()) {
      const group = ensureGroup(record.provider)
      const totals = emptyTotals()
      let rows = []
      let kind = 'day'

      if (yearNum > 0) {
        kind = 'month'
        const prefix = `${yearNum}-`
        for (const [month, bucket] of Object.entries(record.months ?? {})) {
          if (!month.startsWith(prefix)) continue
          const monthly = emptyTotals()
          addInto(monthly, bucket)
          addInto(totals, monthly)
          rows.push(rowOf(monthly, { month }))
        }
      } else if (allTime) {
        kind = 'year'
        const byYear = new Map()
        for (const [month, bucket] of Object.entries(record.months ?? {})) {
          const y = month.slice(0, 4)
          const monthly = byYear.get(y) ?? emptyTotals()
          addInto(monthly, bucket)
          byYear.set(y, monthly)
        }
        rows = [...byYear.entries()]
          .map(([y, monthly]) => {
            addInto(totals, monthly)
            return rowOf(monthly, { year: y })
          })
          .sort((a, b) => (a.year < b.year ? 1 : a.year > b.year ? -1 : 0))
      } else {
        for (const [day, buckets] of Object.entries(record.hours)) {
          if (from !== '' && day < from) continue
          const dayTotals = emptyTotals()
          for (const bucket of Object.values(buckets)) addInto(dayTotals, bucket)
          if (dayTotals.calls === 0 && dayTotals.tokens.total === 0) continue
          addInto(totals, dayTotals)
          rows.push(rowOf(dayTotals, { day }))
        }
        rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      }

      if (rows.length === 0) continue
      addInto(group.totals, totals)
      group.totals.cost = roundMoney(group.totals.cost)
      group.totals.peakCost = roundMoney(group.totals.peakCost)
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
        cost: roundMoney(totals.cost),
        peakCost: roundMoney(totals.peakCost),
        costKnown: price.source !== SOURCE_NONE,
        price,
        firstCall: record.firstCall,
        lastCall: record.lastCall,
        daily: kind === 'day' ? rows : [],
        months: kind === 'month' ? rows : [],
        years: kind === 'year' ? rows : [],
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
    overall.cost = roundMoney(overall.cost)
    overall.peakCost = roundMoney(overall.peakCost)

    return {
      generatedAt: now,
      updatedAt: this.updatedAt || this.loadedAt,
      kind: yearNum > 0 ? 'month' : allTime ? 'year' : 'day',
      days: yearNum > 0 ? 0 : days,
      year: yearNum || null,
      from: yearNum > 0 ? `${yearNum}-01-01` : from || null,
      years,
      months,
      showCost: this.showCost,
      retainDays: this.retainDays,
      utcOffsetHours: this.utcOffsetHours,
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
   * 单个模型的明细（供页面二次展开使用）。
   * - 默认/按天：小时桶，按日期、小时升序
   * - year>0：该年各月
   * - days=0 且无 year：各年
   * @param {{ provider?: string, model?: string, days?: number, year?: number }} [options]
   */
  modelDetail({ provider, model, days = 0, year = 0 } = {}) {
    const providerId = String(provider || '')
    const modelId = String(model || '')
    const yearNum = Math.max(0, Math.floor(Number(year) || 0))
    const windowDays = Math.max(0, Number(days) || 0)
    const allTime = yearNum === 0 && windowDays === 0
    const grain = yearNum > 0 ? 'month' : allTime ? 'year' : 'hour'
    const from = grain === 'hour' && windowDays > 0 ? dayKeyBefore(windowDays - 1, Date.now(), this.utcOffsetHours) : ''
    const totals = emptyTotals()
    const hours = []
    const record = this.records.get(`${providerId}/${modelId}`)
    if (record) {
      if (grain === 'hour') {
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
      } else if (grain === 'month') {
        const prefix = `${yearNum}-`
        for (const [month, bucket] of Object.entries(record.months ?? {})) {
          if (!month.startsWith(prefix) || !bucket) continue
          addInto(totals, bucket)
          hours.push({
            month,
            calls: bucket.calls,
            failed: bucket.failed,
            aborted: bucket.aborted,
            tokens: { ...bucket.tokens },
            cost: bucket.cost,
            peakCost: bucket.peakCost,
          })
        }
        hours.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
      } else {
        const byYear = new Map()
        for (const [month, bucket] of Object.entries(record.months ?? {})) {
          if (!bucket) continue
          const y = month.slice(0, 4)
          const yearly = byYear.get(y) ?? emptyTotals()
          addInto(yearly, bucket)
          byYear.set(y, yearly)
        }
        for (const [y, yearly] of byYear) {
          addInto(totals, yearly)
          hours.push({
            year: y,
            calls: yearly.calls,
            failed: yearly.failed,
            aborted: yearly.aborted,
            tokens: { ...yearly.tokens },
            cost: roundMoney(yearly.cost),
            peakCost: roundMoney(yearly.peakCost),
          })
        }
        hours.sort((a, b) => (a.year < b.year ? -1 : a.year > b.year ? 1 : 0))
      }
    }
    totals.cost = roundMoney(totals.cost)
    totals.peakCost = roundMoney(totals.peakCost)
    return {
      provider: providerId,
      model: modelId,
      grain,
      windowDays,
      year: yearNum || null,
      from: from || null,
      hours,
      totals,
    }
  }
}
