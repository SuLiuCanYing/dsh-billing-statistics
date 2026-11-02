import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPricer } from '../pricing.js'
import { FILE_VERSION, UsageStore } from '../usage-store.js'

const CUSTOM = { 'p/m': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } }
const NOON = Date.parse('2026-11-04T10:00:00+08:00')

async function tempStore(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'llmu-test-'))
  const store = new UsageStore({
    directory,
    retainDays: 30,
    pricer: createPricer({ custom: CUSTOM }),
    ...options,
  })
  await store.load()
  return { store, directory }
}

test('recordCall 累加到小时桶与总计', async () => {
  const { store, directory } = await tempStore()
  store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1_000_000, outputTokens: 0 }, at: NOON })
  store.recordCall({ provider: 'p', model: 'm', outcome: 'failed', usage: {}, at: NOON })
  store.recordCall({ provider: 'p', model: 'm', outcome: 'aborted', usage: {}, at: NOON })

  const { platforms } = store.summary({ days: 7 })
  assert.equal(platforms.length, 1)
  const model = platforms[0].models[0]
  assert.equal(model.calls, 3)
  assert.equal(model.failed, 1)
  assert.equal(model.aborted, 1)
  assert.equal(model.tokens.input, 1_000_000)
  assert.equal(model.cost, 2)
  assert.equal(model.peakCost, 2)
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

test('flush 原子落盘，重开后数据一致', async () => {
  const { store, directory } = await tempStore()
  store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 500_000, outputTokens: 100_000 }, at: NOON })
  await store.flush()
  const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
  assert.equal(raw.version, FILE_VERSION)
  assert.equal(raw.records['p/m'].calls, 1)
  assert.equal(raw.records['p/m'].hours['2026-11-04']['10'].calls, 1)

  const reopened = new UsageStore({ directory, retainDays: 30, pricer: createPricer({ custom: CUSTOM }) })
  await reopened.load()
  const { platforms } = reopened.summary({ days: 7 })
  assert.equal(platforms[0].models[0].tokens.input, 500_000)
  assert.equal(platforms[0].models[0].cost, 1.8)
  await reopened.close()
  await rm(directory, { recursive: true, force: true })
})

test('v1（daily）文件迁移到小时桶', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmu-test-'))
  const v1 = {
    version: 1,
    updatedAt: NOON,
    records: {
      'p/m': {
        provider: 'p',
        model: 'm',
        calls: 2,
        tokens: { input: 1000, output: 200 },
        cost: 1.25,
        firstCall: NOON,
        lastCall: NOON,
        daily: { '2026-11-04': { calls: 2, tokens: { input: 1000, output: 200 }, cost: 1.25 } },
      },
    },
  }
  await writeFile(join(directory, 'usage.json'), JSON.stringify(v1), 'utf8')
  const store = new UsageStore({ directory, retainDays: 30, pricer: createPricer({ custom: CUSTOM }) })
  await store.load()
  assert.equal(store.migrated, true)
  assert.equal(store.records.get('p/m').hours['2026-11-04']['12'].calls, 2)
  const { platforms } = store.summary({ days: 7 })
  assert.equal(platforms[0].models[0].calls, 2)
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

test('prune 清理超出保留期的桶并重算总计', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmu-test-'))
  await writeFile(
    join(directory, 'usage.json'),
    JSON.stringify({
      version: FILE_VERSION,
      records: {
        'p/m': {
          provider: 'p',
          model: 'm',
          calls: 3,
          tokens: { input: 3000, output: 300 },
          cost: 1.2,
          hours: {
            '2020-01-01': { '10': { calls: 2, tokens: { input: 2000, output: 200 }, cost: 0.8, peakCost: 0.8 } },
            '2099-01-01': { '10': { calls: 1, tokens: { input: 1000, output: 100 }, cost: 0.4, peakCost: 0.4 } },
          },
        },
      },
    }),
    'utf8',
  )
  const store = new UsageStore({ directory, retainDays: 30, pricer: createPricer({ custom: CUSTOM }) })
  await store.load()
  const record = store.records.get('p/m')
  assert.equal(record.hours['2020-01-01'], undefined)
  assert.equal(record.calls, 1)
  assert.equal(record.tokens.input, 1000)
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

test('setPricer 后按新价重算历史花费', async () => {
  const { store, directory } = await tempStore()
  store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1_000_000, outputTokens: 0 }, at: NOON })
  assert.equal(store.summary({ days: 7 }).platforms[0].models[0].cost, 2)
  const changed = store.setPricer(createPricer({ custom: { 'p/*': { input: 4, output: 8 } } }))
  assert.equal(changed, 1)
  assert.equal(store.summary({ days: 7 }).platforms[0].models[0].cost, 4)
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

test('按配置的时区偏移切分日期与小时桶', async () => {
  const at = Date.parse('2026-11-04T17:30:00Z')
  const utc = await tempStore({ utcOffsetHours: 0 })
  utc.store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1 }, at })
  assert.deepEqual(Object.keys(utc.store.records.get('p/m').hours), ['2026-11-04'])
  assert.deepEqual(Object.keys(utc.store.records.get('p/m').hours['2026-11-04']), ['17'])
  await utc.store.close()
  await rm(utc.directory, { recursive: true, force: true })

  const beijing = await tempStore({ utcOffsetHours: 8 })
  beijing.store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1 }, at })
  assert.deepEqual(Object.keys(beijing.store.records.get('p/m').hours), ['2026-11-05'])
  assert.deepEqual(Object.keys(beijing.store.records.get('p/m').hours['2026-11-05']), ['01'])
  await beijing.store.close()
  await rm(beijing.directory, { recursive: true, force: true })
})

test('两个实例写同一目录：加锁串行、合并计数、不留锁文件', async () => {
  const first = await tempStore()
  const second = new UsageStore({
    directory: first.directory,
    retainDays: 30,
    pricer: createPricer({ custom: CUSTOM }),
  })
  await second.load()
  first.store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1_000_000 }, at: NOON })
  second.recordCall({ provider: 'p', model: 'm', usage: { outputTokens: 1_000_000 }, at: NOON })
  await Promise.all([first.store.flush(), second.flush()])
  const raw = JSON.parse(await readFile(join(first.directory, 'usage.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw.records), ['p/m'])
  await assert.rejects(readFile(join(first.directory, 'usage.lock'), 'utf8'), /ENOENT/)
  await first.store.close()
  await second.close()
  await rm(first.directory, { recursive: true, force: true })
})

test('reset 会清掉盘上已有数据（不被合并回填）', async () => {
  const { store, directory } = await tempStore()
  store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 1_000_000 }, at: NOON })
  await store.flush()
  assert.equal(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')).records['p/m'].calls, 1)
  await store.reset()
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')).records, {})
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

test('reset 清空内存与磁盘', async () => {
  const { store, directory } = await tempStore()
  store.recordCall({ provider: 'p', model: 'm', usage: { inputTokens: 10 }, at: NOON })
  await store.reset()
  assert.equal(store.summary({ days: 7 }).platforms.length, 0)
  const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw.records), [])
  await store.close()
  await rm(directory, { recursive: true, force: true })
})
