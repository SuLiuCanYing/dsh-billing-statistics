import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beijingParts,
  computeCost,
  createPricer,
  dayKey,
  normalizeOffsetHours,
  normalizeRate,
  normalizeUsage,
  offsetZone,
  rateAt,
  SOURCE_CUSTOM,
  SOURCE_ESTIMATE,
  SOURCE_NONE,
  SOURCE_OFFICIAL,
} from '../pricing.js'

const PEAK = { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 }
const OFF = { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 }

/** 峰谷规则：工作日 9:00-18:00 峰时，其余时段默认价（谷时）。 */
function peakRule(extra = {}) {
  return {
    source: SOURCE_OFFICIAL,
    currency: 'CNY',
    periods: [{ label: '峰时', days: [1, 2, 3, 4, 5], ranges: [[9, 18]], rate: PEAK }],
    defaultRate: OFF,
    defaultLabel: '谷时',
    tiers: [],
    ...extra,
  }
}

const at = (iso) => Date.parse(iso)

test('rateAt：工作日白天按峰时价，夜间按谷时价', () => {
  const wednesdayNoon = at('2026-11-04T10:00:00+08:00')
  const wednesdayNight = at('2026-11-04T23:00:00+08:00')
  assert.deepEqual(rateAt(peakRule(), wednesdayNoon).rate, PEAK)
  assert.equal(rateAt(peakRule(), wednesdayNoon).peak, true)
  assert.deepEqual(rateAt(peakRule(), wednesdayNight).rate, OFF)
  assert.equal(rateAt(peakRule(), wednesdayNight).peak, false)
  assert.equal(rateAt(peakRule(), wednesdayNight).label, '谷时')
})

test('rateAt：周末与节假日不按峰时计', () => {
  const saturdayNoon = at('2026-11-07T10:00:00+08:00')
  assert.deepEqual(rateAt(peakRule(), saturdayNoon).rate, OFF)
  const holidayNoon = at('2026-11-04T10:00:00+08:00')
  const rule = peakRule({ holidays: ['2026-11-04'] })
  assert.deepEqual(rateAt(rule, holidayNoon).rate, OFF)
})

test('rateAt：只有一个价位时按峰时记（避免把平价说成谷时）', () => {
  const flat = { source: SOURCE_CUSTOM, currency: 'CNY', periods: [{ label: '', ranges: [[0, 24]], rate: PEAK }], tiers: [] }
  const picked = rateAt(flat, at('2026-11-04T03:00:00+08:00'))
  assert.equal(picked.peak, true)
  assert.deepEqual(picked.rate, PEAK)
})

test('rateAt：阶梯价按输入长度选档', () => {
  const rule = {
    source: SOURCE_OFFICIAL,
    currency: 'CNY',
    periods: [],
    tiers: [
      { maxPrompt: 32_000, rate: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, label: '短' },
      { maxPrompt: Infinity, rate: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, label: '长' },
    ],
  }
  assert.equal(rateAt(rule, at('2026-11-04T10:00:00+08:00'), 1000).rate.input, 1)
  assert.equal(rateAt(rule, at('2026-11-04T10:00:00+08:00'), 100_000).rate.input, 2)
})

test('rateAt：未定价规则返回零价', () => {
  assert.equal(rateAt({ source: SOURCE_NONE }, Date.now()).rate.input, 0)
  assert.equal(rateAt(null, Date.now()).peak, false)
})

test('createPricer：custom > 官网 > 内置估算，并支持通配键', () => {
  const pricer = createPricer({
    custom: { 'p/model-x': { input: 1, output: 2 } },
    providers: { p: { currency: 'CNY', models: { 'model-x': { periods: [{ label: '', ranges: [[0, 24]], rate: { input: 9, output: 9 } }] } } } },
  })
  assert.equal(pricer.resolve('p', 'model-x').source, SOURCE_CUSTOM)

  const officialOnly = createPricer({ providers: { p: { models: { 'model-x': { periods: [{ label: '', ranges: [[0, 24]], rate: { input: 9, output: 9 } }] } } } } })
  assert.equal(officialOnly.resolve('p', 'model-x').source, SOURCE_OFFICIAL)

  const wildcard = createPricer({ custom: { 'p/*': { input: 3, output: 4 } } })
  assert.equal(wildcard.resolve('p', 'anything').source, SOURCE_CUSTOM)

  const builtin = createPricer({ custom: { '*': { input: 5, output: 6 } } })
  assert.equal(builtin.resolve('unknown-provider', 'm').source, SOURCE_CUSTOM)
})

test('createPricer：全零价视为未定价，落到下一级兜底', () => {
  const pricer = createPricer({ custom: { 'siliconflow2/*': { input: 0, output: 0 } } })
  assert.equal(pricer.resolve('siliconflow2', 'deepseek-ai/DeepSeek-V4.1-Flash').source, SOURCE_ESTIMATE)
})

test('createPricer：美元价按汇率折成人民币', () => {
  const pricer = createPricer({
    usdToCny: 7,
    providers: { openai: { currency: 'USD', models: { gpt: { periods: [{ label: '', ranges: [[0, 24]], rate: { input: 1, output: 2, cacheRead: 0.5 } }] } } } },
  })
  const rule = pricer.resolve('openai', 'gpt')
  assert.equal(rule.source, SOURCE_OFFICIAL)
  assert.equal(rule.periods[0].rate.input, 7)
  assert.equal(rule.periods[0].rate.output, 14)
})

test('computeCost：按百万 token 折算，缺字段按 0', () => {
  const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 }, PEAK)
  assert.equal(cost, 2 + 4 + 0.08)
  assert.equal(computeCost({}, PEAK), 0)
  assert.equal(computeCost(null, PEAK), 0)
})

test('normalizeUsage / normalizeRate：负数与非法值一律归零', () => {
  const usage = normalizeUsage({ inputTokens: -5, outputTokens: '120', cacheReadTokens: 10, reasoningTokens: 3 })
  assert.equal(usage.inputTokens, 0)
  assert.equal(usage.outputTokens, 120)
  assert.equal(usage.totalTokens, 120)
  assert.deepEqual(normalizeRate({ input: -1, output: 'x', cacheRead: 0.5 }), { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 0 })
})

test('时区偏移：beijingParts / dayKey / rateAt 都按传入偏移切分', () => {
  const at = Date.parse('2026-11-04T17:30:00Z')
  assert.equal(beijingParts(at).dayKey, '2026-11-05')
  assert.equal(beijingParts(at).hour, 1)
  assert.equal(beijingParts(at, 0).dayKey, '2026-11-04')
  assert.equal(beijingParts(at, 0).hour, 17)
  assert.equal(dayKey(at), '2026-11-05')
  assert.equal(dayKey(at, 0), '2026-11-04')
  assert.equal(normalizeOffsetHours('abc'), 8)
  assert.equal(normalizeOffsetHours(-20), -12)
  assert.equal(offsetZone(8), '+08:00')
  assert.equal(offsetZone(-3.5), '-03:30')

  const rule = {
    source: 'official',
    currency: 'CNY',
    periods: [
      { label: '峰', ranges: [[9, 18]], rate: { input: 8, output: 16, cacheRead: 0, cacheWrite: 0 } },
      { label: '谷', ranges: [[18, 24]], rate: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0 } },
    ],
    tiers: [],
  }
  const tenUtc = Date.parse('2026-11-04T10:00:00Z')
  assert.equal(rateAt(rule, tenUtc, 0, 0).label, '峰')
  assert.equal(rateAt(rule, tenUtc, 0, 8).label, '谷')
  assert.equal(rateAt(rule, tenUtc, 0, 8).rate.input, 4)
})

