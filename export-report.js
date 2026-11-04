/**
 * 用量报表导出：把 summary + 每个模型的 modelDetail 生成一个自包含 HTML 报表。
 *
 * 设计目标：
 * - 先按平台分组，再按模型列出总用量；每个模型下面直接跟时间明细（按天视图到小时，年/全部视图到月/年）。
 * - 失败/中断调用给出费用可能偏低的提示，避免把报表金额当成平台账单。
 * - 输出不依赖脚本、外部字体或颜色码，浏览器直接打开，也可直接打印为 PDF。
 */

const SOURCE_LABELS = {
  catalog: 'models.dev',
  manual: '人工导入价格',
  official: '官网',
  custom: '自定义',
  estimate: '估算',
  none: '未定价',
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => {
    if (char === '&') return '&amp;'
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    return '&quot;'
  })
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

function detailGrain(summary, detail, rows) {
  if (Array.isArray(detail?.hours) && detail.hours.length > 0) {
    if (detail.grain === 'hour' || detail.grain === 'month' || detail.grain === 'year') return detail.grain
    return 'hour'
  }
  const first = rows?.[0]
  if (first && first.hour !== undefined) return 'hour'
  if (first && first.month !== undefined) return 'month'
  if (first && first.year !== undefined) return 'year'
  if (summary?.kind === 'month') return 'month'
  if (summary?.kind === 'year') return 'year'
  return 'day'
}

function rowsOf(summary, model, detail) {
  if (Array.isArray(detail?.hours) && detail.hours.length > 0) return detail.hours
  if (Array.isArray(model.daily) && model.daily.length > 0) return model.daily
  if (Array.isArray(model.months) && model.months.length > 0) return model.months
  if (Array.isArray(model.years) && model.years.length > 0) return model.years
  return []
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

function modelFailureText(model) {
  const failed = Number(model?.failed) || 0
  const aborted = Number(model?.aborted) || 0
  if (failed === 0 && aborted === 0) return ''
  return `失败 ${integer(failed)} 次 · 中断 ${integer(aborted)} 次，调用失败可能会使花费显示偏低`
}

function renderModelBlock(summary, platform, model, detail) {
  const rows = rowsOf(summary, model, detail)
  const grain = detailGrain(summary, detail, rows)
  const known = model.costKnown !== false && model.price?.source !== 'none'
  const failureText = modelFailureText(model)
  const failureClass = failureText ? ' class="model-failure"' : ''
  const body = rows.length
    ? rows
        .map(
          (row) => `<tr>
      <td class="time">${escapeHtml(timeText(row, grain))}</td>
      <td class="num">${integer(row.calls)}</td>
      <td class="num">${integer(row.failed)}</td>
      <td class="num">${integer(row.aborted)}</td>
      <td class="num">${integer(row.tokens?.input)}</td>
      <td class="num">${integer(row.tokens?.cacheRead)}</td>
      <td class="num">${integer(row.tokens?.cacheWrite)}</td>
      <td class="num">${integer(row.tokens?.output)}</td>
      <td class="num">${money(row.cost, known)}</td>
    </tr>`,
        )
        .join('\n')
    : '<tr><td class="empty" colspan="9">该模型在当前范围内没有按时间拆分的明细</td></tr>'

  return `<article class="model-block">
  <header class="model-head">
    <div class="model-title">
      <h3>${escapeHtml(model.model)}</h3>
      <span class="model-provider">${escapeHtml(platform.displayName || platform.provider)}</span>
    </div>
    <p class="model-meta">调用 ${integer(model.calls)} 次 · 输入 ${integer(model.tokens?.input)} · 缓存读取 ${integer(model.tokens?.cacheRead)} · 缓存写入 ${integer(model.tokens?.cacheWrite)} · 输出 ${integer(model.tokens?.output)} · 花费 ${money(model.cost, known)} · 价格来源 ${escapeHtml(sourceLabel(model))}</p>
    ${failureText ? `<p${failureClass}>${escapeHtml(failureText)}</p>` : ''}
  </header>
  <div class="table-wrap">
    <table class="detail-table">
      <thead>
        <tr>
          <th>${timeHeader(grain)}</th>
          <th class="num">调用</th>
          <th class="num">失败</th>
          <th class="num">中断</th>
          <th class="num">输入 token</th>
          <th class="num">缓存读取 token</th>
          <th class="num">缓存写入 token</th>
          <th class="num">输出 token</th>
          <th class="num">花费（元）</th>
        </tr>
      </thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>
</article>`
}

function renderPlatform(platform, summary, details, detail) {
  const known = platform.models.some((model) => model.costKnown !== false && model.price?.source !== 'none')
  const allKnown = platform.models.every((model) => model.costKnown !== false && model.price?.source !== 'none')
  const modelRows = platform.models
    .map((model) => {
      const modelKnown = model.costKnown !== false && model.price?.source !== 'none'
      return `<tr>
        <td class="model-name">${escapeHtml(model.model)}</td>
        <td class="num">${integer(model.calls)}</td>
        <td class="num">${integer(model.failed)}</td>
        <td class="num">${integer(model.aborted)}</td>
        <td class="num">${integer(model.tokens?.input)}</td>
        <td class="num">${integer(model.tokens?.cacheRead)}</td>
        <td class="num">${integer(model.tokens?.cacheWrite)}</td>
        <td class="num">${integer(model.tokens?.output)}</td>
        <td class="num">${money(model.cost, modelKnown)}</td>
        <td>${escapeHtml(sourceLabel(model))}</td>
      </tr>`
    })
    .join('\n')
  const modelBlocks = detail
    ? platform.models
        .map((model) => renderModelBlock(summary, platform, model, details.get(`${platform.provider}/${model.model}`)))
        .join('\n')
    : '<p class="detail-off">已关闭时间明细，本报表只包含平台与模型汇总。</p>'

  return `<section class="platform-block">
  <header class="platform-head">
    <div>
      <h2>${escapeHtml(platform.displayName || platform.provider)}</h2>
      <p class="provider-id">${escapeHtml(platform.provider)}</p>
    </div>
    <p class="platform-meta">调用 ${integer(platform.totals?.calls)} 次 · 失败 ${integer(platform.totals?.failed)} 次 · 中断 ${integer(platform.totals?.aborted)} 次 · 输入 ${integer(platform.totals?.tokens?.input)} · 缓存 ${integer((platform.totals?.tokens?.cacheRead ?? 0) + (platform.totals?.tokens?.cacheWrite ?? 0))} · 输出 ${integer(platform.totals?.tokens?.output)} · 花费 ${known ? `${money(platform.totals?.cost, true)}${allKnown ? '' : '（已定价部分）'}` : '未定价'}</p>
  </header>
  <div class="table-wrap">
    <table class="summary-table">
      <thead>
        <tr>
          <th>模型</th>
          <th class="num">调用</th>
          <th class="num">失败</th>
          <th class="num">中断</th>
          <th class="num">输入 token</th>
          <th class="num">缓存读取 token</th>
          <th class="num">缓存写入 token</th>
          <th class="num">输出 token</th>
          <th class="num">花费（元）</th>
          <th>价格来源</th>
        </tr>
      </thead>
      <tbody>
${modelRows}
      </tbody>
    </table>
  </div>
  <div class="model-blocks">
${modelBlocks}
  </div>
</section>`
}

/**
 * 生成 HTML 报表。
 * @param {object} summary UsageStore#summary() 的返回值
 * @param {{ generatedAt?: number, details?: Map<string, object>, detail?: boolean }} [options]
 *   details 的 key 是 `provider/model`，value 是 UsageStore#modelDetail() 的返回值。
 *   detail=false 时只导出平台与模型汇总，不展开时间明细。
 */
export function buildReport(summary, { generatedAt = 0, details = new Map(), detail = true } = {}) {
  const platforms = Array.isArray(summary?.platforms) ? summary.platforms : []
  const totals = summary?.totals ?? {}
  const failed = Number(totals.failed) || 0
  const aborted = Number(totals.aborted) || 0
  const known = platforms.some((platform) =>
    (platform.models ?? []).some((model) => model.costKnown !== false && model.price?.source !== 'none'),
  )
  const allKnown = platforms.every((platform) =>
    (platform.models ?? []).every((model) => model.costKnown !== false && model.price?.source !== 'none'),
  )
  const failureNotice =
    failed > 0 || aborted > 0
      ? `<p class="cost-warning"><strong>费用提示</strong> 本报表包含 ${integer(failed)} 次失败调用、${integer(aborted)} 次中断。失败调用如果未上报 token，花费会按 0 计入，报表总额可能低于平台实际账单；请以平台账单为准。</p>`
      : ''
  const timeNote = detail
    ? '<p>时间明细按小时聚合，同一小时内的多次调用合并显示；插件只保存到小时桶，无法还原每次请求的秒级时间。</p>'
    : '<p>本次导出未包含时间明细，只含平台与模型汇总。</p>'

  const platformSections = platforms
    .map((platform) => renderPlatform(platform, summary, details, detail))
    .join('\n')
  const body = platformSections || '<p class="empty">当前范围内没有可导出的用量。</p>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型 API 计费统计报表</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: rgb(246, 247, 249);
    color: rgb(31, 41, 55);
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.55;
  }
  .report { max-width: 1180px; margin: 0 auto; padding: 32px 24px 48px; }
  .report-head h1 { margin: 0 0 6px; font-size: 24px; font-weight: 600; letter-spacing: .01em; }
  .report-meta { margin: 0; color: rgb(107, 114, 128); font-size: 13px; }
  .overview { margin: 24px 0 0; padding: 14px 16px; border: 1px solid rgb(229, 231, 235); border-radius: 8px; background: rgb(255, 255, 255); }
  .overview-line { margin: 0; }
  .overview-line + .overview-line { margin-top: 4px; }
  .cost-warning { margin: 16px 0 0; padding: 10px 12px; border: 1px solid rgb(217, 119, 6); border-radius: 8px; background: rgb(255, 251, 235); font-size: 13px; }
  .cost-warning strong { color: rgb(146, 64, 14); }
  .platforms { margin-top: 28px; }
  .platform-block { margin-top: 24px; padding: 20px; border: 1px solid rgb(229, 231, 235); border-radius: 10px; background: rgb(255, 255, 255); }
  .platform-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 24px; margin-bottom: 14px; }
  .platform-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .provider-id { margin: 2px 0 0; color: rgb(107, 114, 128); font-size: 12px; }
  .platform-meta { margin: 0; color: rgb(75, 85, 99); font-size: 13px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; border-bottom: 1px solid rgb(229, 231, 235); text-align: left; white-space: nowrap; }
  th { background: rgb(249, 250, 251); color: rgb(75, 85, 99); font-size: 12px; font-weight: 600; }
  thead { display: table-header-group; }
  tbody tr:last-child td { border-bottom: 0; }
  .num { text-align: right; }
  .model-name { font-weight: 500; }
  .model-blocks { margin-top: 8px; }
  .model-block { margin-top: 20px; padding-top: 18px; border-top: 1px solid rgb(229, 231, 235); }
  .model-head { margin-bottom: 10px; }
  .model-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .model-title h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .model-provider { color: rgb(107, 114, 128); font-size: 12px; }
  .model-meta { margin: 4px 0 0; color: rgb(75, 85, 99); font-size: 12px; }
  .model-failure { margin: 4px 0 0; color: rgb(146, 64, 14); font-size: 12px; }
  .detail-off { margin: 14px 0 0; color: rgb(107, 114, 128); font-size: 12px; }
  .empty { padding: 20px 0; color: rgb(107, 114, 128); }
  .detail-table th { font-size: 11px; }
  .report-foot { margin-top: 24px; color: rgb(107, 114, 128); font-size: 12px; }
  .report-foot p { margin: 4px 0 0; }
  @media print {
    body { background: rgb(255, 255, 255); }
    .report { max-width: none; padding: 0; }
    .platform-block { border-color: rgb(209, 213, 219); }
    .model-head { break-inside: avoid; }
  }
</style>
</head>
<body>
<main class="report">
  <header class="report-head">
    <h1>模型 API 计费统计报表</h1>
    <p class="report-meta">统计范围：${escapeHtml(rangeText(summary))}${generatedAt ? ` · 生成时间：${escapeHtml(stamp(generatedAt))}` : ''}</p>
  </header>
  <section class="overview">
    <p class="overview-line">平台 ${integer(platforms.length)} 个 · 模型 ${integer(platforms.reduce((sum, platform) => sum + (platform.models?.length ?? 0), 0))} 个 · 调用 ${integer(totals.calls)} 次 · 失败 ${integer(totals.failed)} 次 · 中断 ${integer(totals.aborted)} 次</p>
    <p class="overview-line">输入 ${integer(totals.tokens?.input)} token · 缓存读取 ${integer(totals.tokens?.cacheRead)} token · 缓存写入 ${integer(totals.tokens?.cacheWrite)} token · 输出 ${integer(totals.tokens?.output)} token · 花费 ${known ? `${money(totals.cost, true)} 元${allKnown ? '' : '（已定价部分）'}` : '未定价'}</p>
  </section>
  ${failureNotice}
  <div class="platforms">
${body}
  </div>
  <footer class="report-foot">
    <p>金额按 0.000001 元精度导出，末尾的 0 已省略；未定价模型显示为“未定价”。</p>
    ${timeNote}
    <p>失败或中断调用如果未上报 token，花费可能偏低；有失败调用的，请以平台账单为准。</p>
  </footer>
</main>
</body>
</html>
`
}
