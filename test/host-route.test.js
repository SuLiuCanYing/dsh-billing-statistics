import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ROUTES, apply } from '../index.js'

const OFFICIAL_MARKDOWN = `| MODEL | MODEL | MODEL | deepseek-flash(1) | deepseek-v4-pro |
| --- | --- | --- | --- | --- |
| PRICING(2) | 1M INPUT TOKENS (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |
| PRICING(2) | 1M INPUT TOKENS (CACHE HIT) | PEAK | $0.006 | $0.044 |
| PRICING(2) | 1M INPUT TOKENS (CACHE MISS) | OFF-PEAK | $0.15 | $0.66 |
| PRICING(2) | 1M INPUT TOKENS (CACHE MISS) | PEAK | $0.3 | $1.32 |
| PRICING(2) | 1M OUTPUT TOKENS | OFF-PEAK | $0.6 | $1.98 |
| PRICING(2) | 1M OUTPUT TOKENS | PEAK | $1.2 | $3.96 |
`

test('apply 注册官方价路由，并返回官网解析结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmu-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const routes = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const value = fn()
      if (typeof value === 'function') cleanups.push(value)
      return () => {}
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    llm: {
      listConfigurableProviders: () => [],
      on: () => () => {},
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => {}
      },
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(OFFICIAL_MARKDOWN, { status: 200, headers: { 'content-type': 'text/markdown' } })
  try {
    apply(ctx, { priceSync: false, retainDays: 30 })
    assert.ok(ROUTES.includes('/api/llm-usage/v1/prices/official'))
    assert.ok(ROUTES.includes('/api/llm-usage/v1/reconcile'))
    const handler = routes.get('/api/llm-usage/v1/prices/official')
    const reconcileHandler = routes.get('/api/llm-usage/v1/reconcile')
    assert.equal(typeof reconcileHandler, 'function')
    assert.equal(typeof handler, 'function')

    const call = async (path, { method = 'GET', body = null, route = handler } = {}) => {
      let status = 0
      let text = ''
      const response = {
        writeHead(code) {
          status = code
        },
        end(chunk) {
          text = String(chunk ?? '')
        },
      }
      let request
      if (body === null) {
        request = { method, url: path, headers: { host: '127.0.0.1:58609' } }
      } else {
        request = new EventEmitter()
        request.method = method
        request.url = path
        request.headers = { host: '127.0.0.1:58609', 'content-type': 'application/json' }
        process.nextTick(() => {
          request.emit('data', Buffer.from(JSON.stringify(body)))
          request.emit('end')
        })
      }
      await route(request, response)
      return { status, payload: JSON.parse(text) }
    }

    const officialResult = await call('/api/llm-usage/v1/prices/official?provider=deepseek-official&refresh=1')
    assert.equal(officialResult.status, 200)
    const payload = officialResult.payload
    assert.equal(payload.ok, true)
    assert.equal(payload.source, 'live')
    assert.equal(payload.provider, 'deepseek-official')
    assert.equal(payload.rows['deepseek-flash'].peakInput, 0.3)
    assert.deepEqual(payload.plan.ranges, [[9, 12], [14, 18]])

    const reconcile = await call('/api/llm-usage/v1/reconcile?day=2026-11-04', { route: reconcileHandler })
    assert.equal(reconcile.status, 200)
    assert.equal(reconcile.payload.ok, true)
    assert.equal(reconcile.payload.day, '2026-11-04')
    assert.ok(Array.isArray(reconcile.payload.providers))
    assert.equal(reconcile.payload.totals.calls, 0)
    const invalidReconcile = await call('/api/llm-usage/v1/reconcile?day=2026-13-40', { route: reconcileHandler })
    assert.equal(invalidReconcile.status, 400)

    const importResult = await call('/api/llm-usage/v1/prices/import', {
      method: 'POST',
      body: {
        provider: 'deepseek-official',
        currency: 'CNY',
        models: { 'deepseek-flash': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        officialOverride: true,
      },
    })
    assert.equal(importResult.status, 200)
    const imported = importResult.payload.prices.providers.find((entry) => entry.provider === 'deepseek-official')
    assert.equal(imported.origin, 'manual')
    assert.equal(imported.manual, true)
    assert.equal(imported.manualOverride, true)

    const clearResult = await call('/api/llm-usage/v1/prices/import', {
      method: 'POST',
      body: { provider: 'deepseek-official', clear: true },
    })
    assert.equal(clearResult.status, 200)
    const cleared = clearResult.payload.prices.providers.find((entry) => entry.provider === 'deepseek-official')
    assert.equal(cleared.origin, 'official')
    assert.equal(cleared.manual, false)
    assert.equal(cleared.manualSaved, false)

    // 旧版客户端保存时没有 officialOverride 字段；保存动作仍应视为人工覆盖。
    const legacySave = await call('/api/llm-usage/v1/prices/import', {
      method: 'POST',
      body: {
        provider: 'deepseek-official',
        currency: 'CNY',
        models: { 'deepseek-flash': { input: 1, output: 2 } },
      },
    })
    assert.equal(legacySave.status, 200)
    const legacyImported = legacySave.payload.prices.providers.find((entry) => entry.provider === 'deepseek-official')
    assert.equal(legacyImported.manual, true)
    assert.equal(legacyImported.manualOverride, true)
  } finally {
    globalThis.fetch = originalFetch
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // 清理失败不影响断言结果。
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
