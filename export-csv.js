/**
 * 用量报表导出：把 store.summary() 的 payload 压成 CSV。
 *
 * 一行 = 某平台 × 某模型 × 某一天；末尾补一行全局「合计」。
 * 输出带 UTF-8 BOM（由路由拼上），Excel 双击打开不乱码。
 */

/** 表头；顺序与 `buildCsv` 里的取值顺序一致。 */
export const CSV_COLUMNS = [
  '日期',
  '平台',
  '平台名',
  '模型',
  '调用次数',
  '失败',
  '中止',
  '输入token',
  '缓存读取token',
  '缓存写入token',
  '输出token',
  '花费(元)',
  '峰时花费(元)',
  '价格来源',
]

/** CSV 单元格转义：含逗号 / 引号 / 换行时加引号并把引号翻倍。 */
function cell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function money(value, known) {
  if (!known) return ''
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : ''
}

/**
 * 生成 CSV 文本（不含 BOM）。
 * @param {object} summary UsageStore#summary() 的返回值
 * @param {{ generatedAt?: number }} [options]
 */
export function buildCsv(summary, { generatedAt = 0 } = {}) {
  const lines = []
  lines.push(CSV_COLUMNS.map(cell).join(','))
  const totals = { calls: 0, failed: 0, aborted: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, peakCost: 0 }

  for (const platform of summary?.platforms ?? []) {
    for (const model of platform.models ?? []) {
      const known = model.costKnown !== false && model.price?.source !== 'none'
      for (const day of model.daily ?? []) {
        lines.push(
          [
            day.day,
            platform.provider,
            platform.displayName,
            model.model,
            day.calls,
            day.failed,
            day.aborted,
            day.tokens?.input ?? 0,
            day.tokens?.cacheRead ?? 0,
            day.tokens?.cacheWrite ?? 0,
            day.tokens?.output ?? 0,
            money(day.cost, known),
            money(day.peakCost, known),
            model.price?.source ?? '',
          ].map(cell).join(','),
        )
        totals.calls += Number(day.calls) || 0
        totals.failed += Number(day.failed) || 0
        totals.aborted += Number(day.aborted) || 0
        totals.tokens.input += Number(day.tokens?.input) || 0
        totals.tokens.cacheRead += Number(day.tokens?.cacheRead) || 0
        totals.tokens.cacheWrite += Number(day.tokens?.cacheWrite) || 0
        totals.tokens.output += Number(day.tokens?.output) || 0
        totals.cost += Number(day.cost) || 0
        totals.peakCost += Number(day.peakCost) || 0
      }
    }
  }

  if (lines.length > 1) {
    lines.push(
      [
        '合计',
        '',
        '',
        '',
        totals.calls,
        totals.failed,
        totals.aborted,
        totals.tokens.input,
        totals.tokens.cacheRead,
        totals.tokens.cacheWrite,
        totals.tokens.output,
        totals.cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
        totals.peakCost.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
        '',
      ].map(cell).join(','),
    )
  }

  if (generatedAt > 0) lines.push(`# generatedAt=${new Date(generatedAt).toISOString()}`)
  return lines.join('\r\n') + '\r\n'
}
