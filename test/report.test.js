import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReport } from '../export-report.js'

const SUMMARY = {
  kind: 'day',
  days: 7,
  from: '2026-10-28',
  totals: {
    calls: 5,
    failed: 1,
    aborted: 1,
    tokens: { input: 111, cacheRead: 20, cacheWrite: 5, output: 55 },
    cost: 0.6,
  },
  platforms: [
    {
      provider: 'deepseek',
      displayName: 'DeepSeek 官方',
      totals: {
        calls: 5,
        failed: 1,
        aborted: 1,
        tokens: { input: 111, cacheRead: 20, cacheWrite: 5, output: 55 },
        cost: 0.6,
      },
      models: [
        {
          model: 'deepseek-chat',
          calls: 4,
          failed: 1,
          aborted: 1,
          costKnown: true,
          price: { source: 'official' },
          tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 },
          cost: 0.5,
          peakCost: 0.25,
          daily: [
            { day: '2026-11-02', calls: 3, failed: 0, aborted: 1, tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 }, cost: 0.5, peakCost: 0.25 },
          ],
        },
        {
          model: 'A & B <test>',
          calls: 1,
          failed: 0,
          aborted: 0,
          costKnown: false,
          price: { source: 'none' },
          tokens: { input: 11, cacheRead: 0, cacheWrite: 0, output: 5 },
          cost: 0,
          peakCost: 0,
          daily: [
            { day: '2026-11-01', calls: 1, failed: 0, aborted: 0, tokens: { input: 11, output: 5 }, cost: 0, peakCost: 0 },
          ],
        },
      ],
    },
  ],
}

const DETAILS = new Map([
  [
    'deepseek/deepseek-chat',
    {
      grain: 'hour',
      hours: [
        { day: '2026-11-02', hour: 14, calls: 2, failed: 1, aborted: 0, tokens: { input: 80, cacheRead: 10, cacheWrite: 5, output: 40 }, cost: 0.4, peakCost: 0.2 },
        { day: '2026-11-02', hour: 9, calls: 1, failed: 0, aborted: 1, tokens: { input: 20, cacheRead: 10, cacheWrite: 0, output: 10 }, cost: 0.1, peakCost: 0.05 },
      ],
    },
  ],
])

test('HTML 报表按平台与模型分组，并包含小时时间明细', () => {
  const html = buildReport(SUMMARY, { generatedAt: Date.UTC(2026, 10, 2, 6, 30), details: DETAILS })
  assert.match(html, /<h2>DeepSeek 官方<\/h2>/)
  assert.match(html, /deepseek-chat/)
  assert.match(html, /2026-11-02 14:00/)
  assert.match(html, /2026-11-02 09:00/)
  assert.match(html, /价格来源 官网/)
  assert.match(html, /价格来源 未定价/)
})

test('有失败调用时给出花费可能显示偏低的说明', () => {
  const html = buildReport(SUMMARY, { generatedAt: 0, details: DETAILS })
  assert.match(html, /费用提示/)
  assert.match(html, /报表总额可能低于平台实际账单/)
  assert.match(html, /失败 1 次 · 中断 1 次，调用失败可能会使花费显示偏低/)
})

test('没有失败调用时不渲染费用提示', () => {
  const summary = {
    ...SUMMARY,
    totals: { ...SUMMARY.totals, failed: 0, aborted: 0 },
    platforms: [
      {
        ...SUMMARY.platforms[0],
        totals: { ...SUMMARY.platforms[0].totals, failed: 0, aborted: 0 },
        models: SUMMARY.platforms[0].models.map((model) => ({ ...model, failed: 0, aborted: 0 })),
      },
    ],
  }
  const html = buildReport(summary, { generatedAt: 0, details: new Map() })
  assert.doesNotMatch(html, /费用提示/)
})

test('导出内容不含井号与波浪号，并对动态文本做 HTML 转义', () => {
  const html = buildReport(SUMMARY, { generatedAt: Date.UTC(2026, 10, 2, 6, 30), details: DETAILS })
  assert.equal(html.includes('#'), false)
  assert.equal(html.includes('~'), false)
  assert.match(html, /A &amp; B &lt;test&gt;/)
  assert.doesNotMatch(html, /<test>/)
})

test('关闭时间明细时只输出平台与模型汇总', () => {
  const html = buildReport(SUMMARY, { generatedAt: 0, details: DETAILS, detail: false })
  assert.doesNotMatch(html, /<article class="model-block">/)
  assert.match(html, /已关闭时间明细/)
  assert.equal(html.includes('2026-11-02 14:00'), false)
})

test('月份视图使用月份表头，年视图使用年份表头', () => {
  const monthly = buildReport(
    {
      kind: 'month',
      year: 2026,
      totals: SUMMARY.totals,
      platforms: [
        {
          ...SUMMARY.platforms[0],
          models: [
            {
              ...SUMMARY.platforms[0].models[0],
              daily: [],
              months: [{ month: '2026-01', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 1 }, cost: 0.1, peakCost: 0.1 }],
              years: [],
            },
          ],
        },
      ],
    },
    { generatedAt: 0, details: new Map() },
  )
  assert.match(monthly, /<th>月份<\/th>/)
  assert.match(monthly, /2026-01/)

  const yearly = buildReport(
    {
      kind: 'year',
      year: null,
      totals: SUMMARY.totals,
      platforms: [
        {
          ...SUMMARY.platforms[0],
          models: [
            {
              ...SUMMARY.platforms[0].models[0],
              daily: [],
              months: [],
              years: [{ year: '2026', calls: 1, failed: 0, aborted: 0, tokens: { input: 1, output: 1 }, cost: 0.1, peakCost: 0.1 }],
            },
          ],
        },
      ],
    },
    { generatedAt: 0, details: new Map() },
  )
  assert.match(yearly, /<th>年份<\/th>/)
  assert.match(yearly, />2026</)
})
