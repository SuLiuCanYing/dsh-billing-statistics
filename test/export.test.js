import assert from 'node:assert/strict'
import test from 'node:test'

import { CSV_COLUMNS, buildCsv } from '../export-csv.js'

const SUMMARY = {
  from: '2026-11-01',
  days: 7,
  platforms: [
    {
      provider: 'deepseek',
      displayName: 'DeepSeek 官方',
      models: [
        {
          model: 'deepseek-chat',
          costKnown: true,
          price: { source: 'official' },
          daily: [
            { day: '2026-11-02', calls: 3, failed: 0, aborted: 1, tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 }, cost: 0.5, peakCost: 0.25 },
            { day: '2026-11-01', calls: 1, failed: 1, aborted: 0, tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, cost: 0.1, peakCost: 0 },
          ],
        },
        {
          model: 'weird, "quoted" model',
          costKnown: false,
          price: { source: 'none' },
          daily: [{ day: '2026-11-01', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, peakCost: 0 }],
        },
      ],
    },
  ],
}

test('CSV 表头与逐日行', () => {
  const lines = buildCsv(SUMMARY).trimEnd().split('\r\n')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.equal(lines[1].split(',')[0], '2026-11-02')
  assert.equal(lines[2].split(',')[0], '2026-11-01')
  const third = lines[3]
  assert.match(third, /"weird, ""quoted"" model"/)
  // 未定价的行花费留空，不写 0（行尾是 花费,,峰时花费,,价格来源）。
  assert.ok(third.endsWith(',,none'), third)
})

test('CSV 末尾合计行', () => {
  const lines = buildCsv(SUMMARY).trimEnd().split('\r\n')
  const total = lines.at(-1).split(',')
  assert.equal(total[0], '合计')
  assert.equal(total[4], '5')
  assert.equal(total[7], '111')
  assert.equal(total[13], '')
})

test('CSV 金额按 6 位小数导出', () => {
  const summary = {
    platforms: [
      {
        provider: 'p',
        displayName: 'P',
        models: [
          {
            model: 'm',
            costKnown: true,
            price: { source: 'official' },
            daily: [
              { day: '2026-11-02', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 1 }, cost: 0.19171896, peakCost: 0.19171896 },
              { day: '2026-11-01', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 1 }, cost: 0.00004, peakCost: 0 },
            ],
          },
        ],
      },
    ],
  }
  const lines = buildCsv(summary).trimEnd().split('\r\n')
  assert.equal(lines[1].split(',')[11], '0.191719')
  assert.equal(lines[2].split(',')[11], '0.00004')
  // 合计行避免浮点尾数：0.19171896 + 0.00004 → 0.191759
  assert.equal(lines.at(-1).split(',')[11], '0.191759')
})

test('年份 / 全部视图按月、按年导出', () => {
  const model = {
    provider: 'p',
    model: 'm',
    costKnown: true,
    price: { source: 'official' },
    daily: [],
  }
  const monthly = buildCsv({
    platforms: [
      {
        provider: 'p',
        displayName: 'P',
        models: [
          {
            ...model,
            months: [
              { month: '2026-01', calls: 2, failed: 0, aborted: 0, tokens: { input: 2, output: 1 }, cost: 0.5, peakCost: 0.5 },
              { month: '2026-02', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 1 }, cost: 0.25, peakCost: 0 },
            ],
            years: [],
          },
        ],
      },
    ],
  })
    .trimEnd()
    .split('\r\n')
  assert.equal(monthly[1].split(',')[0], '2026-01')
  assert.equal(monthly[2].split(',')[0], '2026-02')
  assert.equal(monthly.at(-1).split(',')[11], '0.75')

  const yearly = buildCsv({
    platforms: [
      {
        provider: 'p',
        displayName: 'P',
        models: [
          {
            ...model,
            months: [],
            years: [
              { year: '2026', calls: 3, failed: 0, aborted: 0, tokens: { input: 3, output: 2 }, cost: 0.75, peakCost: 0.5 },
              { year: '2025', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 0 }, cost: 0.25, peakCost: 0.25 },
            ],
          },
        ],
      },
    ],
  })
    .trimEnd()
    .split('\r\n')
  assert.equal(yearly[1].split(',')[0], '2026')
  assert.equal(yearly[2].split(',')[0], '2025')
  assert.equal(yearly.at(-1).split(',')[11], '1')
})

test('空数据只有表头', () => {
  const lines = buildCsv({ platforms: [] }).trimEnd().split('\r\n')
  assert.equal(lines.length, 1)
  assert.equal(lines[0], CSV_COLUMNS.join(','))
})

test('CSV 不再附加井号元数据，也不含波浪号', () => {
  const csv = buildCsv(SUMMARY, { generatedAt: Date.UTC(2026, 10, 2, 6, 30) })
  assert.equal(csv.includes('#'), false)
  assert.equal(csv.includes('~'), false)
})
