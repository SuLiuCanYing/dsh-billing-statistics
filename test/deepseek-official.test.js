import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PLUGIN_VERSION,
  builtinOfficialPricing,
  isDeepSeekOfficialProvider,
  officialModelEntry,
  officialModelIds,
  officialPlanForOffset,
  officialPlanUtc,
  officialPriceRows,
  officialProviderModels,
  parseOfficialMarkdown,
} from '../deepseek-official.js'
import { createPricer } from '../pricing.js'
import { ROUTES, manualPriceIsActive, priceReport } from '../index.js'

const OFFICIAL_MARKDOWN = `# Models & Pricing

| MODEL | MODEL | MODEL | deepseek-flash(1) | deepseek-v4-pro |
| --- | --- | --- | --- | --- |
| PRICING(2) | 1M INPUT TOKENS (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |
| PRICING(2) | 1M INPUT TOKENS (CACHE HIT) | PEAK | $0.006 | $0.044 |
| PRICING(2) | 1M INPUT TOKENS (CACHE MISS) | OFF-PEAK | $0.15 | $0.66 |
| PRICING(2) | 1M INPUT TOKENS (CACHE MISS) | PEAK | $0.3 | $1.32 |
| PRICING(2) | 1M OUTPUT TOKENS | OFF-PEAK | $0.6 | $1.98 |
| PRICING(2) | 1M OUTPUT TOKENS | PEAK | $1.2 | $3.96 |
`

test('DeepSeek 官方 provider 只认明确 id 或官方 baseURL', () => {
  assert.equal(isDeepSeekOfficialProvider({ provider: 'deepseek' }), true)
  assert.equal(isDeepSeekOfficialProvider({ provider: 'deepseek-official' }), true)
  assert.equal(isDeepSeekOfficialProvider({ provider: 'deepseek-account' }), true)
  assert.equal(isDeepSeekOfficialProvider({ provider: 'siliconflow', displayName: 'DeepSeek' }), false)
  assert.equal(isDeepSeekOfficialProvider({ provider: 'custom', defaultBaseURL: 'https://api.deepseek.com/anthropic' }), true)
  assert.equal(isDeepSeekOfficialProvider({ provider: 'proxy', defaultBaseURL: 'https://api.deepseek.com.evil/v1' }), false)
})

test('内置官方价表包含官网模型与旧模型别名', () => {
  const data = builtinOfficialPricing()
  const ids = officialModelIds(data)
  assert.deepEqual(ids.sort(), ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'])
  assert.equal(officialModelEntry('deepseek-v4-flash', data).id, 'deepseek-flash')
  assert.equal(officialModelEntry('deepseek-v4-flash', data).peak.input, 0.3)
  const rows = officialPriceRows(data)
  assert.equal(rows['deepseek-flash'].peakOutput, 1.2)
  assert.equal(rows['deepseek-v4-pro'].input, 0.66)
})

test('官方价在 UTC 峰时/谷时正确计价，并按汇率折成人民币', () => {
  const providers = {
    'deepseek-official': {
      models: officialProviderModels(builtinOfficialPricing()),
      currency: 'USD',
      source: 'official',
    },
  }
  const pricer = createPricer({ providers, usdToCny: 7.1, utcOffsetHours: 8 })
  const peakAt = Date.UTC(2026, 10, 3, 2, 0, 0) // 周二 UTC 02:00，官方峰时
  const offAt = Date.UTC(2026, 10, 3, 0, 0, 0) // 周二 UTC 00:00，官方谷时
  const peak = pricer.priceFor('deepseek-official', 'deepseek-flash', peakAt, 1_000_000)
  assert.equal(peak.rule.source, 'official')
  assert.equal(peak.peak, true)
  assert.equal(peak.rate.input, 2.13)
  const alias = pricer.priceFor('deepseek-official', 'deepseek-v4-flash', peakAt, 1_000_000)
  assert.equal(alias.rule.source, 'official')
  assert.equal(alias.rate.input, 2.13)
  const off = pricer.priceFor('deepseek-official', 'deepseek-flash', offAt, 1_000_000)
  assert.equal(off.peak, false)
  assert.equal(off.rate.input, 1.065)
})

test('官方价表只挂在官方 provider 上，不污染第三方平台', () => {
  const providers = {
    'deepseek-official': { models: officialProviderModels(), currency: 'USD', source: 'official' },
    siliconflow: { models: {}, currency: 'CNY', source: 'catalog' },
  }
  const pricer = createPricer({ providers, usdToCny: 7.1 })
  assert.equal(pricer.resolve('deepseek-official', 'deepseek-flash').source, 'official')
  assert.notEqual(pricer.resolve('siliconflow', 'deepseek-flash').source, 'official')
})

test('官方峰时展示按当前时区位移，计价仍按 UTC', () => {
  assert.deepEqual(officialPlanUtc().ranges, [[1, 4], [6, 10]])
  assert.deepEqual(officialPlanForOffset(8).ranges, [[9, 12], [14, 18]])
  assert.equal(officialPlanForOffset(8).days.join(','), '1,2,3,4,5')
})

test('官网 pricing.md 能解析出价表；结构不完整时拒绝猜测', () => {
  const parsed = parseOfficialMarkdown(OFFICIAL_MARKDOWN)
  assert.equal(parsed.source, 'live')
  assert.equal(parsed.models['deepseek-flash'].peak.input, 0.3)
  assert.equal(parsed.models['deepseek-flash'].offPeak.output, 0.6)
  assert.equal(parsed.models['deepseek-v4-pro'].peak.output, 3.96)
  assert.throws(() => parseOfficialMarkdown('| MODEL | MODEL | MODEL | deepseek-x |\n| --- | --- | --- | --- |'))
})

test('官方平台默认使用 official；旧人工价收起，显式覆盖才生效', () => {
  const report = priceReport({
    snapshot: null,
    config: {},
    providers: ['deepseek-official', 'siliconflow'],
    names: { 'deepseek-official': 'DeepSeek 官方' },
    manual: { providers: {} },
    official: builtinOfficialPricing(),
    officialProviders: new Set(['deepseek-official']),
    activeModels: { 'deepseek-official': ['deepseek-flash'] },
  })
  const official = report.providers.find((entry) => entry.provider === 'deepseek-official')
  assert.equal(official.official, true)
  assert.equal(official.origin, 'official')
  assert.equal(official.usingDefault, false)
  assert.equal(official.officialModels, 1)
  assert.deepEqual(official.peak.ranges, [[1, 4], [6, 10]])

  const legacy = priceReport({
    snapshot: null,
    config: {},
    providers: ['deepseek-official'],
    names: {},
    manual: {
      providers: {
        'deepseek-official': {
          currency: 'CNY',
          models: { 'deepseek-flash': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, origin: 'manual' } },
        },
      },
    },
    official: builtinOfficialPricing(),
    officialProviders: new Set(['deepseek-official']),
    activeModels: { 'deepseek-official': ['deepseek-flash'] },
  }).providers[0]
  assert.equal(legacy.origin, 'official')
  assert.equal(legacy.manual, false)
  assert.equal(legacy.manualSaved, true)
  assert.equal(legacy.manualOverride, false)
  assert.equal(legacy.usingDefault, false)

  const override = priceReport({
    snapshot: null,
    config: {},
    providers: ['deepseek-official'],
    names: {},
    manual: {
      providers: {
        'deepseek-official': {
          currency: 'CNY',
          officialOverride: true,
          models: { 'deepseek-flash': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, origin: 'manual' } },
        },
      },
    },
    official: builtinOfficialPricing(),
    officialProviders: new Set(['deepseek-official']),
    activeModels: { 'deepseek-official': ['deepseek-flash'] },
  }).providers[0]
  assert.equal(override.origin, 'manual')
  assert.equal(override.manual, true)
  assert.equal(override.manualOverride, true)
  assert.equal(override.usingDefault, false)

  assert.equal(manualPriceIsActive('siliconflow', { models: {} }), true)
  assert.equal(manualPriceIsActive('deepseek-official', { models: {} }, new Set(['deepseek-official'])), false)
  assert.equal(
    manualPriceIsActive('deepseek-official', { models: {}, officialOverride: true }, new Set(['deepseek-official'])),
    true,
  )
})

test('官方价接口已注册到 Host 路由表', () => {
  assert.ok(ROUTES.includes('/api/llm-usage/v1/prices/official'))
  assert.equal(new Set(ROUTES).size, ROUTES.length)
})

test('插件版本号与 package.json 一致', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, packageJson.version)
})
