import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import zlib from 'node:zlib'

import { buildPdf } from '../export-pdf.js'

const HAS_FONT =
  existsSync('C:\\Windows\\Fonts\\simhei.ttf') ||
  existsSync('/Library/Fonts/Arial Unicode.ttf') ||
  existsSync('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf')

const SUMMARY = {
  kind: 'day',
  days: 7,
  from: '2026-10-28',
  totals: {
    calls: 4,
    failed: 1,
    aborted: 1,
    tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 },
    cost: 0.5,
  },
  platforms: [
    {
      provider: 'deepseek',
      displayName: 'DeepSeek 官方',
      totals: {
        calls: 4,
        failed: 1,
        aborted: 1,
        tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 50 },
        cost: 0.5,
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
          daily: [],
        },
      ],
    },
  ],
}

const DETAILS = new Map([  [
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

function analyzePdf(buffer) {
  const source = buffer.toString('latin1')
  const objects = new Map()
  const objectRe = /(\d+) 0 obj\r?\n([\s\S]*?)endobj/g
  let match
  while ((match = objectRe.exec(source))) objects.set(Number(match[1]), match[2])

  const pages = []
  for (const [id, body] of [...objects].sort((a, b) => a[0] - b[0])) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue
    const contents = body.match(/\/Contents\s+(\d+) 0 R/)
    let text = ''
    if (contents) {
      const stream = objects.get(Number(contents[1]))?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)
      if (stream) {
        try {
          text = zlib.inflateSync(Buffer.from(stream[1], 'latin1')).toString('latin1')
        } catch {
          text = ''
        }
      }
    }
    pages.push({ id, text, textOps: (text.match(/BT\b/g) ?? []).length })
  }
  return pages
}

test('PDF 报表生成有效文件并自动分页', { skip: !HAS_FONT ? '本机没有测试用中文字体' : false }, async () => {
  const pdf = await buildPdf(SUMMARY, { generatedAt: Date.now(), details: DETAILS, detail: true })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length > 1000, `PDF 过小：${pdf.length}`)
  const pages = analyzePdf(pdf)
  assert.ok(pages.length >= 1, `没有分页对象：${pages.length}`)
  assert.ok(pages.every((page) => page.textOps > 1), `存在只有页脚的空白页：${pages.map((page) => page.textOps).join(',')}`)
  const widths = pages.flatMap((page) => [...page.text.matchAll(/([\d.]+) w\b/g)].map((entry) => Number(entry[1])))
  assert.ok(widths.length > 0)
  assert.ok(widths.every((width) => width <= 0.4), `分隔线过粗：${widths.join(',')}`)
})

test('PDF 关闭时间明细时仍能生成汇总报表', { skip: !HAS_FONT ? '本机没有测试用中文字体' : false }, async () => {
  const pdf = await buildPdf(SUMMARY, { generatedAt: 0, details: new Map(), detail: false })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length > 1000)
})
