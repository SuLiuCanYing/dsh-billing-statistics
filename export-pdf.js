/**
 * PDF 报表：沿用 HTML 报表的分组方式，用 PDFKit 直接排版。
 *
 * 不依赖浏览器或网络；中文使用本机 TrueType 字体并做子集嵌入。
 * 表格自动分页，并在每页重复表头；页脚加页码。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PAGE_MARGIN = 36
const FOOTER_SPACE = 24
const HEADER_HEIGHT = 18

const COLORS = {
  text: [0.12, 0.16, 0.22],
  muted: [0.42, 0.45, 0.5],
  line: [0.9, 0.92, 0.95],
  head: [0.96, 0.97, 0.98],
  warning: [0.55, 0.16, 0.08],
}

const SOURCE_LABELS = {
  catalog: 'models.dev',
  manual: '人工导入价格',
  official: '官网',
  custom: '自定义',
  estimate: '估算',
  none: '未定价',
}

function integer(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function money(value, known) {
  if (!known) return '未定价'
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function sourceLabel(model) {
  const source = model?.price?.source ?? 'none'
  return SOURCE_LABELS[source] ?? '未知'
}

function stamp(timestamp) {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

function rangeText(summary) {
  if (summary?.kind === 'month') return `${summary.year} 年 1 至 12 月`
  if (summary?.kind === 'year') return '全部年份'
  const days = Number(summary?.days) || 0
  if (summary?.from) return `近 ${days} 天（${summary.from} 起）`
  return `近 ${days} 天`
}

function modelFailureText(model) {
  const failed = Number(model?.failed) || 0
  const aborted = Number(model?.aborted) || 0
  if (failed === 0 && aborted === 0) return ''
  return `失败 ${integer(failed)} 次 · 中断 ${integer(aborted)} 次，调用失败可能会使花费显示偏低`
}

function findChineseFont() {
  const env = String(process.env.LLMU_PDF_FONT || '').trim()
  const candidates = [
    env,
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'simhei.ttf') : '',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simkai.ttf',
    'C:\\Windows\\Fonts\\simfang.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
  ]
  return candidates.find((path) => path && existsSync(path)) || ''
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom - FOOTER_SPACE
}

function ensureSpace(doc, height, onNewPage) {
  if (doc.y + height <= pageBottom(doc)) return false
  doc.addPage()
  if (onNewPage) onNewPage()
  return true
}

function textBlock(doc, text, options = {}) {
  const size = options.size ?? 9
  const color = options.color ?? COLORS.text
  const width = options.width ?? doc.page.width - doc.page.margins.left - doc.page.margins.right
  doc.fontSize(size).fillColor(color)
  const height = doc.heightOfString(String(text ?? ''), { width, align: options.align ?? 'left' })
  ensureSpace(doc, height + 6, options.onNewPage)
  doc.text(String(text ?? ''), options.x ?? doc.page.margins.left, doc.y, {
    width,
    align: options.align ?? 'left',
    lineGap: options.lineGap ?? 1,
  })
  return doc.y
}

function drawTable(doc, columns, rows, options = {}) {
  const font = options.font
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0)
  const left = doc.page.margins.left
  let y = doc.y

  const drawHeader = () => {
    doc.rect(left, y, totalWidth, HEADER_HEIGHT).fill(COLORS.head)
    let x = left
    for (const column of columns) {
      doc
        .font(font)
        .fontSize(7.2)
        .fillColor(COLORS.muted)
        .text(column.label, x + 3, y + 5, {
          width: column.width - 6,
          align: column.align ?? 'left',
          lineBreak: false,
        })
      x += column.width
    }
    doc
      .moveTo(left, y + HEADER_HEIGHT)
      .lineTo(left + totalWidth, y + HEADER_HEIGHT)
      .strokeColor(COLORS.line)
      .lineWidth(0.3)
      .stroke()
    y += HEADER_HEIGHT
  }

  const newPage = () => {
    doc.addPage()
    y = doc.page.margins.top
    drawHeader()
  }

  if (y + HEADER_HEIGHT > pageBottom(doc)) {
    doc.addPage()
    y = doc.page.margins.top
  }
  drawHeader()

  for (const row of rows) {
    const cells = columns.map((column) => String(row[column.key] ?? ''))
    const heights = cells.map((cell, index) =>
      doc
        .font(font)
        .fontSize(7.4)
        .heightOfString(cell, { width: columns[index].width - 6, lineBreak: true }),
    )
    const rowHeight = Math.max(17, Math.max(...heights) + 6)
    if (y + rowHeight > pageBottom(doc)) newPage()

    let x = left
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]
      doc
        .font(font)
        .fontSize(7.4)
        .fillColor(COLORS.text)
        .text(cells[index], x + 3, y + 3, {
          width: column.width - 6,
          align: column.align ?? 'left',
          lineBreak: true,
        })
      x += column.width
    }
    doc
      .moveTo(left, y + rowHeight)
      .lineTo(left + totalWidth, y + rowHeight)
      .strokeColor(COLORS.line)
      .lineWidth(0.25)
      .stroke()
    y += rowHeight
  }

  doc.y = y
  doc.x = left
}

function drawWarning(doc, text) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const x = doc.page.margins.left
  doc.fontSize(8.5)
  const height = doc.heightOfString(text, { width: width - 16, lineGap: 1.5 }) + 12
  ensureSpace(doc, height + 8)
  const y = doc.y + 4
  doc
    .rect(x, y, width, height)
    .lineWidth(0.4)
    .fillAndStroke([0.99, 0.98, 0.95], COLORS.warning)
  doc
    .fontSize(8.5)
    .fillColor(COLORS.warning)
    .text(text, x + 8, y + 6, { width: width - 16, lineGap: 1.5 })
  doc.y = y + height + 8
  doc.x = doc.page.margins.left
}

function rowsOf(model, detail) {
  if (Array.isArray(detail?.hours) && detail.hours.length > 0) return detail.hours
  if (Array.isArray(model.daily) && model.daily.length > 0) return model.daily
  if (Array.isArray(model.months) && model.months.length > 0) return model.months
  if (Array.isArray(model.years) && model.years.length > 0) return model.years
  return []
}

function grainOf(summary, detail, rows) {
  if (Array.isArray(detail?.hours) && detail.hours.length > 0) {
    if (detail.grain === 'hour' || detail.grain === 'month' || detail.grain === 'year') return detail.grain
    return 'hour'
  }
  const first = rows[0]
  if (first && first.hour !== undefined) return 'hour'
  if (first && first.month !== undefined) return 'month'
  if (first && first.year !== undefined) return 'year'
  if (summary?.kind === 'month') return 'month'
  if (summary?.kind === 'year') return 'year'
  return 'day'
}

function timeText(row, grain) {
  if (grain === 'hour') {
    const hour = String(Math.max(0, Math.min(23, Number(row.hour) || 0))).padStart(2, '0')
    return `${row.day ?? ''} ${hour}:00`
  }
  if (grain === 'month') return String(row.month ?? '')
  if (grain === 'year') return String(row.year ?? '')
  return String(row.day ?? '')
}

function timeHeader(grain) {
  if (grain === 'hour') return '时间'
  if (grain === 'month') return '月份'
  if (grain === 'year') return '年份'
  return '日期'
}

function drawModelSummary(doc, platform, font) {
  const columns = [
    { key: 'model', label: '模型', width: 100 },
    { key: 'calls', label: '调用', width: 38, align: 'right' },
    { key: 'failed', label: '失败', width: 30, align: 'right' },
    { key: 'aborted', label: '中断', width: 30, align: 'right' },
    { key: 'input', label: '输入 token', width: 48, align: 'right' },
    { key: 'cacheRead', label: '缓存读取 token', width: 54, align: 'right' },
    { key: 'cacheWrite', label: '缓存写入 token', width: 54, align: 'right' },
    { key: 'output', label: '输出 token', width: 48, align: 'right' },
    { key: 'cost', label: '花费（元）', width: 55, align: 'right' },
    { key: 'source', label: '价格来源', width: 46 },
  ]
  const rows = platform.models.map((model) => {
    const known = model.costKnown !== false && model.price?.source !== 'none'
    return {
      model: model.model,
      calls: integer(model.calls),
      failed: integer(model.failed),
      aborted: integer(model.aborted),
      input: integer(model.tokens?.input),
      cacheRead: integer(model.tokens?.cacheRead),
      cacheWrite: integer(model.tokens?.cacheWrite),
      output: integer(model.tokens?.output),
      cost: money(model.cost, known),
      source: sourceLabel(model),
    }
  })
  drawTable(doc, columns, rows, { font })
}

function drawModelDetail(doc, summary, platform, model, detail, font) {
  const rows = rowsOf(model, detail)
  const grain = grainOf(summary, detail, rows)
  const columns = [
    { key: 'time', label: timeHeader(grain), width: 110 },
    { key: 'calls', label: '调用', width: 38, align: 'right' },
    { key: 'failed', label: '失败', width: 30, align: 'right' },
    { key: 'aborted', label: '中断', width: 30, align: 'right' },
    { key: 'input', label: '输入 token', width: 50, align: 'right' },
    { key: 'cacheRead', label: '缓存读取 token', width: 58, align: 'right' },
    { key: 'cacheWrite', label: '缓存写入 token', width: 58, align: 'right' },
    { key: 'output', label: '输出 token', width: 50, align: 'right' },
    { key: 'cost', label: '花费（元）', width: 60, align: 'right' },
  ]
  const known = model.costKnown !== false && model.price?.source !== 'none'
  const values = rows.map((row) => ({
    time: timeText(row, grain),
    calls: integer(row.calls),
    failed: integer(row.failed),
    aborted: integer(row.aborted),
    input: integer(row.tokens?.input),
    cacheRead: integer(row.tokens?.cacheRead),
    cacheWrite: integer(row.tokens?.cacheWrite),
    output: integer(row.tokens?.output),
    cost: money(row.cost, known),
  }))
  drawTable(doc, columns, values, { font })
}

/**
 * 生成 PDF 报表。
 * @param {object} summary UsageStore#summary() 的返回值
 * @param {{ generatedAt?: number, details?: Map<string, object>, detail?: boolean }} [options]
 * @returns {Promise<Buffer>}
 */
export async function buildPdf(summary, { generatedAt = 0, details = new Map(), detail = true } = {}) {
  const font = findChineseFont()
  if (!font) {
    throw new Error('找不到可用的中文字体；请设置 LLMU_PDF_FONT 指向一个 TrueType 字体文件')
  }

  let PDFDocument
  try {
    const loaded = await import('pdfkit')
    PDFDocument = loaded?.default ?? loaded
  } catch (error) {
    throw new Error(`PDF 依赖不可用：${String(error?.message ?? error)}`)
  }
  if (typeof PDFDocument !== 'function') {
    throw new Error('PDF 依赖不可用：pdfkit 导出不是构造函数')
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    info: { Title: '模型 API 计费统计报表', Creator: 'dsh-billing-statistics' },
  })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  const finished = new Promise((resolve, reject) => {
    doc.on('end', resolve)
    doc.on('error', reject)
  })

  try {
    const platforms = Array.isArray(summary?.platforms) ? summary.platforms : []
    const totals = summary?.totals ?? {}
    const known = platforms.some((platform) =>
      (platform.models ?? []).some((model) => model.costKnown !== false && model.price?.source !== 'none'),
    )
    const allKnown = platforms.every((platform) =>
      (platform.models ?? []).every((model) => model.costKnown !== false && model.price?.source !== 'none'),
    )

    doc.font(font).fontSize(20).fillColor(COLORS.text).text('模型 API 计费统计报表', { lineGap: 2 })
    doc.moveDown(0.3)
    doc
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(
        `统计范围：${rangeText(summary)}${generatedAt ? ` · 生成时间：${stamp(generatedAt)}` : ''}`,
        { lineGap: 1.5 },
      )
    doc.moveDown(1)

    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(
        `平台 ${integer(platforms.length)} 个 · 模型 ${integer(platforms.reduce((sum, platform) => sum + (platform.models?.length ?? 0), 0))} 个 · 调用 ${integer(totals.calls)} 次 · 失败 ${integer(totals.failed)} 次 · 中断 ${integer(totals.aborted)} 次`,
        { lineGap: 2 },
      )
    doc.text(
      `输入 ${integer(totals.tokens?.input)} token · 缓存读取 ${integer(totals.tokens?.cacheRead)} token · 缓存写入 ${integer(totals.tokens?.cacheWrite)} token · 输出 ${integer(totals.tokens?.output)} token · 花费 ${known ? `${money(totals.cost, true)} 元${allKnown ? '' : '（已定价部分）'}` : '未定价'}`,
      { lineGap: 2 },
    )

    const failed = Number(totals.failed) || 0
    const aborted = Number(totals.aborted) || 0
    if (failed > 0 || aborted > 0) {
      drawWarning(
        doc,
        `费用提示：本报表包含 ${integer(failed)} 次失败调用、${integer(aborted)} 次中断。失败调用如果未上报 token，花费会按 0 计入，报表总额可能低于平台实际账单；请以平台账单为准。`,
      )
    }

    for (const platform of platforms) {
      ensureSpace(doc, 110)
      doc.moveDown(0.7)
      doc.x = PAGE_MARGIN
      doc.fontSize(14).fillColor(COLORS.text).text(platform.displayName || platform.provider, { lineGap: 2 })
      doc
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(platform.provider, { lineGap: 1.5 })
      const platformKnown = platform.models.some((model) => model.costKnown !== false && model.price?.source !== 'none')
      const platformAllKnown = platform.models.every((model) => model.costKnown !== false && model.price?.source !== 'none')
      doc
        .fontSize(8.5)
        .fillColor(COLORS.text)
        .text(
          `调用 ${integer(platform.totals?.calls)} 次 · 失败 ${integer(platform.totals?.failed)} 次 · 中断 ${integer(platform.totals?.aborted)} 次 · 输入 ${integer(platform.totals?.tokens?.input)} · 缓存 ${integer((platform.totals?.tokens?.cacheRead ?? 0) + (platform.totals?.tokens?.cacheWrite ?? 0))} · 输出 ${integer(platform.totals?.tokens?.output)} · 花费 ${platformKnown ? `${money(platform.totals?.cost, true)}${platformAllKnown ? '' : '（已定价部分）'}` : '未定价'}`,
          { lineGap: 1.5 },
        )
      doc.moveDown(0.4)
      drawModelSummary(doc, platform, font)

      if (detail) {
        for (const model of platform.models) {
          ensureSpace(doc, 45)
          doc.moveDown(0.7)
          doc.x = PAGE_MARGIN
          doc.fontSize(10).fillColor(COLORS.text).text(model.model, { lineGap: 1.5 })
          const knownModel = model.costKnown !== false && model.price?.source !== 'none'
          doc
            .fontSize(7.5)
            .fillColor(COLORS.muted)
            .text(
              `调用 ${integer(model.calls)} 次 · 输入 ${integer(model.tokens?.input)} · 缓存读取 ${integer(model.tokens?.cacheRead)} · 缓存写入 ${integer(model.tokens?.cacheWrite)} · 输出 ${integer(model.tokens?.output)} · 花费 ${money(model.cost, knownModel)} · 价格来源 ${sourceLabel(model)}`,
              { lineGap: 1.5 },
            )
          const failure = modelFailureText(model)
          if (failure) {
            doc.fontSize(7.5).fillColor(COLORS.warning).text(failure, { lineGap: 1.5 })
          }
          doc.moveDown(0.25)
          drawModelDetail(doc, summary, platform, model, details.get(`${platform.provider}/${model.model}`), font)
        }
      }
    }

    if (!detail && platforms.length > 0) {
      doc.fontSize(8).fillColor(COLORS.muted).text('本次导出未包含时间明细，只含平台与模型汇总。', { lineGap: 1.5 })
    }

    doc.moveDown(1)
    doc
      .fontSize(7.5)
      .fillColor(COLORS.muted)
      .text('金额按 0.000001 元精度导出，末尾的 0 已省略；未定价模型显示为“未定价”。', { lineGap: 1.5 })
      .text(
        detail
          ? '时间明细按小时聚合，同一小时内的多次调用合并显示；插件只保存到小时桶，无法还原每次请求的秒级时间。'
          : '本次导出未包含时间明细。',
        { lineGap: 1.5 },
      )
      .text('失败或中断调用如果未上报 token，花费可能偏低；有失败调用的，请以平台账单为准。', { lineGap: 1.5 })

    const range = doc.bufferedPageRange()
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index)
      doc
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(`第 ${index - range.start + 1} 页 / 共 ${range.count} 页`, PAGE_MARGIN, doc.page.height - doc.page.margins.bottom - 12, {
          width: doc.page.width - PAGE_MARGIN * 2,
          align: 'center',
          lineBreak: false,
        })
    }

    doc.end()
    await finished
    return Buffer.concat(chunks)
  } catch (error) {
    try {
      doc.end()
    } catch {
      // 生成失败时只保留原始错误。
    }
    throw error
  }
}
