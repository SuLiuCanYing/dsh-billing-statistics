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
  if (!Number.isFinite(n)) return ''
  // 账本金额统一到 6 位小数；这是导出能拿到的最高精度。
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/** 汇总行金额：先四舍五入到 6 位，避免浮点累加出现 0.30000000000000004。 */
function sumMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return (Math.round(n * 1000000) / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 生成 CSV 文本（不含 BOM）。
 * 兼容旧导出入口；不再向文件尾追加井号元数据，避免影响观感。
 * @param {object} summary UsageStore#summary() 的返回值
 * @param {{ generatedAt?: number }} [options] 兼容旧调用，当前不写入 CSV
 */
export function buildCsv(summary, { generatedAt = 0 } = {}) {
  const lines = []
  lines.push(CSV_COLUMNS.map(cell).join(','))
  const totals = { calls: 0, failed: 0, aborted: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, peakCost: 0 }

  for (const platform of summary?.platforms ?? []) {
    for (const model of platform.models ?? []) {
      const known = model.costKnown !== false && model.price?.source !== 'none'
      // 按天 / 按月（年份视图）/ 按年（全部视图）共用同一套列，只是首列粒度不同。
      const rows =
        (model.daily && model.daily.length > 0 ? model.daily : null) ??
        (model.months && model.months.length > 0 ? model.months : null) ??
        model.years ??
        []
      for (const row of rows) {
        const slot = row.day ?? row.month ?? row.year ?? ''
        lines.push(
          [
            slot,
            platform.provider,
            platform.displayName,
            model.model,
            row.calls,
            row.failed,
            row.aborted,
            row.tokens?.input ?? 0,
            row.tokens?.cacheRead ?? 0,
            row.tokens?.cacheWrite ?? 0,
            row.tokens?.output ?? 0,
            money(row.cost, known),
            money(row.peakCost, known),
            model.price?.source ?? '',
          ].map(cell).join(','),
        )
        totals.calls += Number(row.calls) || 0
        totals.failed += Number(row.failed) || 0
        totals.aborted += Number(row.aborted) || 0
        totals.tokens.input += Number(row.tokens?.input) || 0
        totals.tokens.cacheRead += Number(row.tokens?.cacheRead) || 0
        totals.tokens.cacheWrite += Number(row.tokens?.cacheWrite) || 0
        totals.tokens.output += Number(row.tokens?.output) || 0
        totals.cost += Number(row.cost) || 0
        totals.peakCost += Number(row.peakCost) || 0
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
        sumMoney(totals.cost),
        sumMoney(totals.peakCost),
        '',
      ].map(cell).join(','),
    )
  }

  return lines.join('\r\n') + '\r\n'
}
