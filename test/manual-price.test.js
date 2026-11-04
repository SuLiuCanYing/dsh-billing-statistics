import test from 'node:test'
import assert from 'node:assert/strict'
import { createPricer, mergeManualPriceModels, normalizeManualPeak, normalizeManualPriceModels, retimeManualPriceModels, SOURCE_MANUAL } from '../pricing.js'

test('normalizeManualPriceModels 生成可计价的模型表并标记 manual', () => {
  const models = normalizeManualPriceModels({
    'demo-model': { input: 2, output: 8, cacheRead: 0.04 },
    'usd-model': { input: 1, output: 2 },
  })
  assert.equal(models['demo-model'].origin, 'manual')
  assert.equal(models['demo-model'].periods[0].rate.output, 8)
  assert.equal(models['usd-model'].currency, 'CNY')
})

test('人工导入价格会被 pricer 识别为 manual，而不是 models.dev', () => {
  const models = normalizeManualPriceModels({ 'demo-model': { input: 2, output: 8 } })
  const pricer = createPricer({ providers: { demo: { models, currency: 'CNY' } } })
  const rule = pricer.resolve('demo', 'demo-model')
  assert.equal(rule.source, SOURCE_MANUAL)
  assert.equal(rule.periods[0].rate.input, 2)
  assert.equal(pricer.priceFor('demo', 'demo-model', Date.now()).rate.output, 8)
})

test('人工导入的精确模型 ID 优先于目录别名', () => {
  const models = normalizeManualPriceModels({ alias: { input: 99, output: 199 } })
  const pricer = createPricer({
    providers: {
      demo: {
        models: { ...models, real: { periods: [{ ranges: [[0, 24]], rate: { input: 1, output: 2 } }] } },
        aliases: { alias: 'real' },
      },
    },
  })
  assert.equal(pricer.resolve('demo', 'alias').periods[0].rate.input, 99)
})

test('normalizeManualPriceModels 拒绝全 0 与空表', () => {
  assert.throws(() => normalizeManualPriceModels({ m: { input: 0, output: 0 } }), /没有有效价格/)
  assert.throws(() => normalizeManualPriceModels({}), /没有可导入/)
})

test('mergeManualPriceModels 只覆盖填写的模型，保留未填写的旧价', () => {
  const old = normalizeManualPriceModels({
    keep: { input: 1, output: 2 },
    change: { input: 3, output: 4 },
  })
  const next = normalizeManualPriceModels({ change: { input: 9, output: 10 } })
  const merged = mergeManualPriceModels(old, next)
  assert.deepEqual(Object.keys(merged).sort(), ['change', 'keep'])
  assert.equal(merged.keep.periods[0].rate.input, 1)
  assert.equal(merged.change.periods[0].rate.input, 9)
})

test('人工峰时价按工作日时段命中，基础价覆盖其余时段', () => {
  const peak = normalizeManualPeak({ ranges: [[9, 12], [14, 18]], days: [1, 2, 3, 4, 5] })
  const models = normalizeManualPriceModels(
    { m: { input: 1, output: 2, peakInput: 3, peakOutput: 4 } },
    { peak },
  )
  assert.equal(models.m.periods.length, 2)
  assert.match(models.m.periods[0].label, /峰时/)
  assert.deepEqual(models.m.periods[0].ranges, [[9, 12], [14, 18]])
  const pricer = createPricer({ providers: { p: { models, currency: 'CNY' } } })
  const monday10 = Date.UTC(2026, 10, 2, 2) // 北京时间周一 10:00
  const monday8 = Date.UTC(2026, 10, 2, 0) // 北京时间周一 08:00
  assert.equal(pricer.priceFor('p', 'm', monday10).rate.input, 3)
  assert.equal(pricer.priceFor('p', 'm', monday10).peak, true)
  assert.equal(pricer.priceFor('p', 'm', monday8).rate.input, 1)
  assert.equal(pricer.priceFor('p', 'm', monday8).peak, false)
})

test('retimeManualPriceModels 把旧峰时价搬到新时段', () => {
  const models = normalizeManualPriceModels(
    { m: { input: 1, output: 2, peakInput: 3, peakOutput: 4 } },
    { peak: { ranges: [[9, 12]] } },
  )
  const moved = retimeManualPriceModels(models, { ranges: [[14, 18]], days: [1, 2, 3, 4, 5] })
  assert.deepEqual(moved.m.periods[0].ranges, [[14, 18]])
  assert.equal(moved.m.periods[0].rate.input, 3)
  assert.equal(moved.m.periods[1].rate.input, 1)
  const cleared = retimeManualPriceModels(models, null)
  assert.equal(cleared.m.periods.length, 1)
  assert.equal(cleared.m.periods[0].rate.input, 1)
})

test('normalizeManualPeak 拒绝越界时段，峰时价没有基础价时报错', () => {
  assert.throws(() => normalizeManualPeak({ ranges: [[12, 9]] }), /峰时时段/)
  assert.throws(() => normalizeManualPeak({ ranges: [[9, 25]] }), /峰时时段/)
  assert.throws(
    () => normalizeManualPriceModels({ m: { peakInput: 3 } }, { peak: { ranges: [[9, 12]] } }),
    /基础价为 0/,
  )
  assert.throws(
    () => normalizeManualPriceModels({ m: { input: 1, peakInput: 3 } }),
    /没有设置峰时时段/,
  )
})
