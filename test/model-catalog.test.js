import test from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogPriceEntry,
  normalizeCatalog,
  normalizeModelKey,
  providerCandidates,
  readBundledCatalog,
  lookupCatalogModel,
} from '../model-catalog.js'

const raw = {
  deepseek: {
    name: 'DeepSeek',
    models: {
      'deepseek-flash': {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
        cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0 },
      },
    },
  },
  'siliconflow-cn': {
    name: 'SiliconFlow',
    models: {
      'deepseek-ai/DeepSeek-V4-Flash': {
        id: 'deepseek-ai/DeepSeek-V4-Flash',
        name: 'DeepSeek V4 Flash',
        canonical_model_id: 'deepseek/deepseek-v4-flash',
        cost: { input: 0.45, output: 1.35, cache_read: 0.045, cache_write: 0 },
      },
    },
  },
  modal: {
    name: 'Modal',
    models: {
      'deepseek-ai/DeepSeek-V4.1-Flash': {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
        name: 'DeepSeek V4.1 Flash',
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
        cost: { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0 },
      },
    },
  },
}

const catalog = normalizeCatalog(raw, { fetchedAt: 1000 })

test('模型 id 归一：去掉命名空间并统一分隔符', () => {
  assert.equal(normalizeModelKey('DeepSeek-AI/DeepSeek_V4.1 Flash'), 'deepseek-v4-1-flash')
  assert.equal(normalizeModelKey('deepseek-ai/DeepSeek-V4.1-Flash'), 'deepseek-v4-1-flash')
})

test('平台别名：siliconflow2 / 硅基流动会先找 siliconflow-cn', () => {
  const ids = providerCandidates('siliconflow2', '硅基流动')
  assert.equal(ids[0], 'siliconflow-cn')
  assert.ok(ids.includes('siliconflow'))
})

test('同平台精确匹配返回 provider 价，不标参考价', () => {
  const hit = lookupCatalogModel(catalog, {
    provider: 'siliconflow2',
    displayName: '硅基流动',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
  })
  assert.ok(hit)
  assert.equal(hit.provider, 'siliconflow-cn')
  assert.equal(hit.matchKind, 'provider')
  assert.equal(hit.reference, false)
  assert.equal(hit.cost.input, 0.45)
})

test('DeepSeek 账号精确匹配 deepseek-flash', () => {
  const hit = lookupCatalogModel(catalog, {
    provider: 'deepseek-account',
    displayName: 'DeepSeek',
    model: 'deepseek-flash',
  })
  assert.ok(hit)
  assert.equal(hit.provider, 'deepseek')
  assert.equal(hit.matchKind, 'provider')
})

test('目录里没有同平台时，跨平台精确匹配并明确标成参考价', () => {
  const hit = lookupCatalogModel(catalog, {
    provider: 'siliconflow2',
    displayName: '硅基流动',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  })
  assert.ok(hit)
  assert.equal(hit.provider, 'modal')
  assert.equal(hit.matchKind, 'reference')
  assert.equal(hit.reference, true)
})

test('匹配不到返回 null，不瞎猜价格', () => {
  assert.equal(lookupCatalogModel(catalog, {
    provider: 'siliconflow2',
    displayName: '硅基流动',
    model: 'totally-unknown-model',
  }), null)
})

test('catalogPriceEntry 输出美元、catalog 来源和匹配元数据', () => {
  const hit = lookupCatalogModel(catalog, {
    provider: 'siliconflow2',
    displayName: '硅基流动',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  })
  const entry = catalogPriceEntry(hit, 1000)
  assert.equal(entry.currency, 'USD')
  assert.equal(entry.origin, 'catalog')
  assert.equal(entry.catalogProvider, 'modal')
  assert.equal(entry.catalogModel, 'deepseek-ai/DeepSeek-V4.1-Flash')
  assert.equal(entry.matchKind, 'reference')
  assert.deepEqual(entry.periods[0].rate, { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 })
})

test('随插件发布的 models.dev 快照可读取，规模合理', async () => {
  const snapshot = await readBundledCatalog()
  assert.ok(snapshot)
  assert.ok(snapshot.models.length > 5000)
  assert.ok(Object.keys(snapshot.providers).length > 100)
  assert.ok(snapshot.fetchedAt > 0)
})
