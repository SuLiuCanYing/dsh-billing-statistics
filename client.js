const __llmuModuleLoader = typeof window === 'undefined' ? null : window.__ModuleLoader__

if (!__llmuModuleLoader || typeof __llmuModuleLoader.load !== 'function') {
  // 加载器被改名时至少留下可诊断的日志；这里无法凭空恢复宿主 UI。
  console.error('dsh-billing-statistics: window.__ModuleLoader__.load 不可用，插件 UI 未注册。')
} else {
  __llmuModuleLoader.load({
  id: 'dsh-billing-statistics',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useSyncExternalStore = React.useSyncExternalStore

    const NS = 'llm-usage'
    const SIDEBAR_ID = 'llm-usage'
    const PANEL_KEY = 'llm-usage'
    const API_BASE = '/api/llm-usage/v1'
    const POLL_MS = 5000

    function exportRangeQuery(range, year) {
      if (range === 'today') return 'days=1'
      if (range === '7') return 'days=7'
      if (range === '30') return 'days=30'
      if (range === 'year') return `year=${year}`
      return 'days=0'
    }

    function exportFileName(range, format, year) {
      const label =
        range === 'today' ? 'today' : range === '7' ? '7d' : range === '30' ? '30d' : range === 'year' ? String(year) : 'all'
      return `llm-usage-${label}.${format}`
    }

    function downloadUrl(url, filename) {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    }

    /** 导出走 fetch 而不是直接 <a download>，这样 HTTP 500 能变成页面提示。 */
    async function downloadExport(url, filename) {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) {
        let detail = ''
        try {
          const payload = await response.json()
          detail = String(payload?.error ?? '')
        } catch {
          detail = (await response.text().catch(() => '')).slice(0, 200)
        }
        throw new Error(detail || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      downloadUrl(objectUrl, filename)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    }

    function downloadText(text, filename, type = 'text/csv;charset=utf-8') {
      const blob = new Blob([text], { type })
      const url = URL.createObjectURL(blob)
      downloadUrl(url, filename)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /** 把表格导成 Excel 能直接打开的 CSV（带 BOM，单元格做最小转义）。 */
    function priceTemplateCsv(rows) {
      const escape = (value) => {
        const text = String(value ?? '')
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }
      const lines = [['模型', '输入', '输出', '缓存读', '缓存写', '峰时输入', '峰时输出', '峰时缓存读', '峰时缓存写'].join(',')]
      for (const row of rows) {
        lines.push(
          [
            row.id,
            row.input,
            row.output,
            row.cacheRead,
            row.cacheWrite,
            row.peakInput,
            row.peakOutput,
            row.peakCacheRead,
            row.peakCacheWrite,
          ]
            .map(escape)
            .join(','),
        )
      }
      return `\uFEFF${lines.join('\r\n')}\r\n`
    }

    function splitPriceLine(line, delimiter) {
      const cells = []
      let current = ''
      let quoted = false
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i]
        if (char === '"') {
          if (quoted && line[i + 1] === '"') {
            current += '"'
            i += 1
          } else {
            quoted = !quoted
          }
        } else if (char === delimiter && !quoted) {
          cells.push(current.trim())
          current = ''
        } else {
          current += char
        }
      }
      cells.push(current.trim())
      return cells
    }

    function priceHeaderKey(value) {
      const key = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
      if (['model', '模型', '模型id', 'modelid'].includes(key)) return 'id'
      if (['input', '输入', '输入价'].includes(key)) return 'input'
      if (['output', '输出', '输出价'].includes(key)) return 'output'
      if (['cacheread', '缓存读', '缓存读取', '缓存命中'].includes(key)) return 'cacheRead'
      if (['cachewrite', '缓存写', '缓存写入'].includes(key)) return 'cacheWrite'
      if (['peakinput', '峰时输入', '高峰输入', '峰值输入'].includes(key)) return 'peakInput'
      if (['peakoutput', '峰时输出', '高峰输出', '峰值输出'].includes(key)) return 'peakOutput'
      if (['peakcacheread', '峰时缓存读', '高峰缓存读'].includes(key)) return 'peakCacheRead'
      if (['peakcachewrite', '峰时缓存写', '高峰缓存写'].includes(key)) return 'peakCacheWrite'
      return ''
    }

    /** 读取用户用 Excel 填好的 CSV / TSV；返回可合并进表格的行。 */
    function parsePriceFile(text) {
      const clean = String(text ?? '').replace(/^\uFEFF/, '')
      const lines = clean.split(/\r?\n/).filter((line) => line.trim())
      if (lines.length === 0) throw new Error('empty')
      const delimiter = lines[0].includes('\t') ? '\t' : ','
      const header = splitPriceLine(lines[0], delimiter).map(priceHeaderKey)
      const hasHeader = header.includes('id')
      const columns = hasHeader
        ? {
            id: header.indexOf('id'),
            input: header.indexOf('input'),
            output: header.indexOf('output'),
            cacheRead: header.indexOf('cacheRead'),
            cacheWrite: header.indexOf('cacheWrite'),
            peakInput: header.indexOf('peakInput'),
            peakOutput: header.indexOf('peakOutput'),
            peakCacheRead: header.indexOf('peakCacheRead'),
            peakCacheWrite: header.indexOf('peakCacheWrite'),
          }
        : { id: 0, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, peakInput: -1, peakOutput: -1, peakCacheRead: -1, peakCacheWrite: -1 }
      if (columns.id < 0) throw new Error('header')
      if (hasHeader && [columns.input, columns.output, columns.cacheRead, columns.cacheWrite].some((index) => index < 0)) {
        throw new Error('header')
      }
      const rows = []
      for (const line of hasHeader ? lines.slice(1) : lines) {
        const cells = splitPriceLine(line, delimiter)
        const id = String(cells[columns.id] ?? '').trim()
        if (!id) continue
        const pick = (index) => (index >= 0 ? String(cells[index] ?? '').trim() : '')
        rows.push({
          id,
          input: pick(columns.input),
          output: pick(columns.output),
          cacheRead: pick(columns.cacheRead),
          cacheWrite: pick(columns.cacheWrite),
          peakInput: pick(columns.peakInput),
          peakOutput: pick(columns.peakOutput),
          peakCacheRead: pick(columns.peakCacheRead),
          peakCacheWrite: pick(columns.peakCacheWrite),
        })
      }
      if (rows.length === 0) throw new Error('empty')
      const priceFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'peakInput', 'peakOutput', 'peakCacheRead', 'peakCacheWrite']
      if (!rows.some((row) => priceFields.some((key) => String(row[key] ?? '').trim() !== ''))) {
        throw new Error('prices')
      }
      return rows
    }

    /* -------------------------------- 本地化文案 -------------------------------- */

    const dictionaries = {
      zh: {
        nav: '计费统计',
        title: '模型计费统计',
        subtitle: '{platforms} 个平台 · {models} 个模型 · 更新于 {updated}',
        scopeNote: '计量单位是每一次模型请求尝试，含重试与标题生成、压缩等辅助调用。',
        scopeOnly: '只有目标时间段调用过的模型才会在该插件显示。',
        rangeLabel: '统计范围',
        rangeToday: '今天',
        range7: '近 7 天',
        range30: '近 30 天',
        rangeAll: '全部',
        live: '自动刷新',
        liveHint: '每 5 秒自动刷新；页面切到后台时暂停。',
        refresh: '刷新',
        refreshing: '刷新中…',
        reset: '清空数据',
        confirmReset: '确定清空已记录的用量数据吗？该操作不可撤销。',
        retry: '重试',
        loading: '正在读取用量数据…',
        failed: '读取用量数据失败。',
        stale: '上次刷新失败：{error}',
        cardCalls: '调用次数',
        cardCallsHint: '{platforms} 个平台 · {models} 个模型',
        cardTokens: 'Token 总量',
        cardTokensHint: '输入 {prompt} · 输出 {output}',
        cardCost: '花费',
        cardCostHint: '按 models.dev / 人工导入价格 / DeepSeek 官方价 / 配置价格折算，不是账单',
        cardOk: '成功率',
        cardOkHint: '失败 {failed} · 中断 {aborted}',
        unpricedTitle: '部分模型没有价格：',
        unpricedBody: '{models}。这些模型只统计 token，不计花费；可在插件配置 pricing 中补上价格。',
        listSeparator: '、',
        listMore: '（共 {count} 个）',
        statTokens: 'Token',
        statCost: '花费',
        colModel: '模型',
        colCalls: '调用',
        colOk: '成功率',
        colInput: '输入 Token',
        colInputHint: '输入 = 未命中缓存的输入 + 缓存命中 + 缓存写入',
        colOutput: '输出 Token',
        colOutputHint: '输出 token 含思考（reasoning）token',
        colCost: '花费',
        colCostHint: '按价格表折算的估算值，不是平台账单',
        colPrice: '价格计算数据来源',
        colPriceHint: '「models.dev」是自动检索的结构化目录价；「人工导入」是本页手填价，优先于目录价；「DeepSeek 官方」是官方 API 自动价；「已配置」来自插件 pricing；「内置估算」是兜底',
        priceCustom: '已配置',
        priceCatalog: 'models.dev',
        priceManual: '人工导入',
        priceEstimate: '内置估算',
        priceMissing: '未配置',
        priceOfficial: 'DeepSeek 官方',
        priceOfficialAuto: '官方自动价',
        priceOfficialLive: '官网实时',
        priceOfficialCache: '官网缓存',
        priceOfficialBuiltin: '内置表',
        priceBannerOfficial: 'DeepSeek 官方价：{providers}（{source}，最近 {time}）',
        priceOfficialNote: '这是 DeepSeek 官方 API：已自动启用官方峰时 / 谷时价格，价格从官网读取并折算；仅限 DeepSeek 官方 API，不会套用到其他平台。打开导入窗口时会先尝试读取官网最新价，失败则使用内置官方表。',
        priceOfficialNoteTitle: 'DeepSeek 官方 API 自动价',
        priceOfficialLoading: '正在读取 DeepSeek 官网价…',
        priceOfficialLoaded: '已读取官网最新价（{source}）',
        priceOfficialFallback: '官网价读取失败，已使用内置官方价：{error}',
        priceOfficialNoModels: '当前没有匹配的官方价模型',
        priceOfficialManualHint: '官方价已自动生效，无需保存；下方数值可用于微调，保存后人工价优先。',
        priceLegacyManualNote: '检测到旧版人工价：当前已由 DeepSeek 官方价接管，旧数值仍保存在配置里；保存下方数值后会重新转为人工覆盖。',
        sourceRestoreOfficial: '改用官方价',
        sourceRestoringOfficial: '恢复中…',
        sourceOfficialRestored: '已移除人工覆盖，恢复 DeepSeek 官方自动价',
        sourceStatusOfficial: 'DeepSeek 官方自动价 {models} 个模型（峰谷按 UTC）',
        sourceOfficialTag: 'DeepSeek 官方',
        rateInline: '输入 {input} · 输出 {output} · 缓存 {cacheRead}',
        priceHours: '{from}–{to} 点',
        priceOtherWindow: '其余时段',
        monthAxis: '{month} 月',
        priceBanner: 'models.dev 价格：{providers}（最近 {time}）',
        priceBannerNever: '还没从 models.dev 检索价格，点上方「刷新模型价格」；匹配不到的模型可用「人工导入价格」。',
        priceBannerManual: '人工导入价：{providers}',
        priceSync: '刷新模型价格',
        priceSyncing: '检索中…',
        priceSynced: '更新了 {models} 个模型的价格',
        priceSyncPartial: '部分平台未匹配：{providers}',
        priceSyncNone: '检索失败：{error}',
        priceStale: '今天还没刷新',
        priceAutoNote: '价格来自 models.dev / 人工导入 / 官方自动价；models.dev 每天自动刷新一次。',
        priceManualOnly: '当前使用人工导入价',
        priceDefaultWarn: '当前用的是系统默认 / models.dev 价格：不同平台的 API 价格不同，models.dev 也看不到峰时价；建议点「人工导入价格」按平台填。',
        priceCatalogSnapshot: 'models.dev 在线刷新失败，使用本地快照',
        priceCatalogCache: 'models.dev 在线刷新失败，使用本地缓存',
        sourceCatalogTag: 'models.dev',
        sourceImportTag: '人工导入价格',
        sourceStatusCatalog: 'models.dev 匹配 {models} 个模型',
        sourceStatusReference: 'models.dev 参考价 {models} 个模型（{provider}）',
        sourceStatusManual: '人工导入价格 {models} 个模型',
        sourcePeakNote: '峰时 {window}',
        sourceStatusNone: 'models.dev 未匹配到这些模型，暂时按内置规则计费',
        sourceFailTitle: 'models.dev 里没找到这些模型的价格，暂时按内置规则计费',
        sourceFailHint: '点「人工导入价格」直接填；models.dev 没收录的平台或模型不会自动出价；DeepSeek 官方 API 会自动使用官方价表。',
        sourceNote: '价格从 models.dev 自动检索，DeepSeek 官方 API 自动读取官方峰谷价；匹配不到或价格不对时，点「人工导入价格」。',
        sourceResync: '重新检索',
        sourceResyncOfficial: '刷新官方价',
        sourceResyncing: '检索中…',
        sourceResynced: '已重新检索 models.dev',
        sourceOfficialRefreshed: '官方价已刷新（{source}）',
        sourceImport: '人工导入价格',
        sourceImportTitle: '人工导入价格',
        sourceImportHint: '给下面每个模型填单价；留空的字段保持旧价，单位：元 / 百万 token，也可选美元。',
        sourceImportTemplate: '下载 CSV 模板',
        sourceImportFile: '从文件导入',
        sourceImportFileHint: '文件用 CSV / TSV：模型、输入、输出、缓存读、缓存写，可再加峰时输入、峰时输出、峰时缓存读、峰时缓存写；可用 Excel 填好再导入。',
        sourceImportFileInvalid: '文件格式不对：至少需要「模型, 输入, 输出, 缓存读, 缓存写」这几列。',
        sourceImportFileDone: '已从文件读入 {models} 个模型，确认后点保存。',
        sourceImportModel: '模型',
        sourceImportInput: '输入',
        sourceImportOutput: '输出',
        sourceImportCacheRead: '缓存读',
        sourceImportCacheWrite: '缓存写',
        sourceImportPeakInput: '峰时输入',
        sourceImportPeakOutput: '峰时输出',
        sourceImportPeakCacheRead: '峰时缓存读',
        sourceImportPeakCacheWrite: '峰时缓存写',
        sourceImportPeak: '启用峰时时段',
        sourceImportPeakWindow: '峰时时段',
        sourceImportPeakPlaceholder: '例如 09:00-12:00, 14:00-18:00',
        sourceImportPeakDays: '适用日期',
        sourceImportDaysAll: '每天',
        sourceImportDaysWeekday: '工作日',
        sourceImportDaysWeekend: '周末',
        sourceImportDaysCustom: '自定义（保持原样）',
        sourceImportPeakHint: '时段按整点，结束可写 24:00；峰时价留空的模型仍按基础价全天计费。',
        sourceImportPeakOffHint: '不启用时，所有模型按基础价全天计费。',
        sourceImportBaseTitle: '基础价（峰时以外）',
        sourceImportSingleTitle: '单价（全天）',
        sourceImportPeakTitle: '峰时价（可选，留空按基础价）',
        sourceImportPeakInvalid: '峰时时段格式不对：按整点填写，例如 09:00-12:00, 14:00-18:00。',
        sourceImportModelPlaceholder: '填写模型 ID',
        sourceImportAdd: '添加模型',
        sourceImportRemove: '删除',
        sourceImportCurrency: '币种',
        sourceImportNote: '留空的字段保持旧价；新模型留空按 0 处理。人工导入价格优先于官方自动价、models.dev 和内置规则。',
        sourceImportInvalid: '价格必须是非负数字。',
        sourceImportEmpty: '至少给一个模型填写价格。',
        sourceImportSaving: '保存中…',
        sourceImportConfirm: '保存并重算',
        sourceImportCancel: '取消',
        sourceImportSaved: '已保存 {models} 个模型的人工价格',
        sourceImportFailed: '导入失败：{error}',
        peakLabel: '峰时',
        offPeakLabel: '谷时',
        costSplit: '峰 {peak} · 谷 {off}',
        tierNote: '阶梯价（按输入长度分档）',
        windowAllDay: '全天',
        priceTipTitle: '单价（元 / 百万 token；models.dev 与 DeepSeek 官方美元价已折算）',
        costHint: '估算',
        costFullHint: '显示完整小数（6 位）',
        costHideHint: '隐藏完整小数',
        modelCalls: '{calls} 次 · 最近 {last}',
        modelFailureNote: '失败 {failed} 次 · 中断 {aborted} 次，调用失败可能会使花费显示偏低',
        modelCount: '{provider} · {models} 个模型',
        colCache: '缓存 Token',
        colCacheHint: '缓存命中（读取）token；有缓存写入时在下方标注',
        uncachedNote: '未命中 {tokens}',
        cacheWriteNote: '写入 {tokens}',
        reasoningNote: '含思考 {tokens}',
        failureDetail: '失败 {failed} · 中断 {aborted}',
        rateTitle: '¥/百万 token：输入 {input} · 输出 {output} · 缓存 {cacheRead}',
        trendTitle: '每日调用',
        trendTitleMonth: '每月调用',
        trendTitleYear: '每年调用',
        trendHint: '柱高为当天调用次数；鼠标移到柱子上看日期与花费',
        trendHintMonth: '柱高为当月调用次数；鼠标移到柱子上看月份与花费',
        trendHintYear: '柱高为当年调用次数；鼠标移到柱子上看年份与花费',
        trendRange: '{days} 天 · 峰值 {peak} 次',
        trendRangePeriod: '共 {periods} 段 · 峰值 {peak} 次',
        trendBar: '{day}：{calls} 次调用 · {tokens} token · {cost}',
        trendTipDay: '{day} {weekday}',
        trendTipPeriod: '{period}',
        trendTipCalls: '{calls} 次调用',
        trendTipTokens: '{tokens} token',
        trendTipCost: '花费 {cost}',
        trendTipSplit: '峰 {peak} · 谷 {off}',
        trendTipEmpty: '这天没有调用',
        trendTipEmptyPeriod: '这段时间没有调用',
        weekdays: '周日,周一,周二,周三,周四,周五,周六',
        detailTitle: '时间明细',
        detailHint: '按小时统计这个模型的 token 与花费',
        detailToggle: '展开时间明细',
        detailCollapse: '收起时间明细',
        detailLoading: '正在读取明细…',
        detailEmpty: '这段时间没有更细的分段记录',
        detailError: '明细加载失败：{error}',
        detailDay: '日期',
        detailHour: '时段',
        detailSum: '合计',
        detailTruncated: '仅显示最近 {count} 段，更早的记录已省略',
        detailDayLabel: '查看日期',
        detailToday: '今天',
        detailAllDays: '全部日期',
        detailDaySum: '当天 {calls} 次 · {tokens} token',
        detailDaySumCost: '当天 {calls} 次 · {tokens} token · {cost}',
        detailEmptyDay: '这一天没有调用记录',
        detailMonthTitle: '各月明细',
        detailYearTitle: '各年明细',
        detailMonthHint: '{year} 年各月的 token 与花费',
        detailYearHint: '各年的 token 与花费',
        detailMonth: '月份',
        detailYear: '年份',
        empty: '还没有记录到模型调用。',
        emptyHint: '在这个 Harness 里发起一次对话（或让子代理、标题生成等调用模型），数据会出现在这里。',
        footerRetention: '按天明细保留 {days} 天；月度汇总长期保留，可切换年份查看。',
        exportReport: '导出报表',
        exportHint: '打开导出设置：可选 HTML / PDF、统计范围与是否包含时间明细。',
        exportTitle: '导出报表',
        exportFormat: '格式',
        exportFormatHtml: 'HTML 报表',
        exportFormatPdf: 'PDF 文档',
        exportPdfHint: 'PDF 使用本机中文字体生成；若生成失败，请改用 HTML。',
        exportRange: '统计范围',
        exportRangeYear: '{year} 年',
        exportDetail: '包含时间明细',
        exportDetailHint: '按天视图包含小时明细；年 / 全部视图导出月 / 年汇总。',
        exportDataWarning: '包含逐小时明细会显著增加行数；数据量大时文件可能过大，请按需勾选。',
        exportFailed: '导出失败：{error}',
        exportCancel: '取消',
        exportConfirm: '导出',
        exporting: '导出中…',
        reconcileOpen: '官方账单对齐',
        reconcileHint: '把官方后台的当日金额、调用次数等填进来，和插件记录对比；插件不读取登录态。',
        reconcileTitle: '官方账单对齐',
        reconcileIntro: '官方账单一般要登录对应平台（如 DeepSeek 开放平台）才能查看，也没有给插件读取账单的公开接口；本插件不保存账号、不抓取页面。请从官方后台抄当天汇总，填到下面做对比。官方不提供调用次数时留空即可。',
        reconcileProvider: '平台',
        reconcileDay: '日期',
        reconcileOfficialCalls: '官方调用次数（可选）',
        reconcileOfficialCost: '官方金额（元）',
        reconcileOfficialTokens: '官方 Token（可选）',
        reconcileLocal: '插件记录',
        reconcileOfficial: '官方账单',
        reconcileDelta: '差额（官方 − 插件）',
        reconcileCalls: '调用',
        reconcileCost: '金额',
        reconcileTokens: 'Token',
        reconcileMissing: '官方更多，插件少记',
        reconcileExtra: '官方更少，插件多记',
        reconcileAligned: '已对齐',
        reconcileEmptyDay: '这一天没有插件记录。',
        reconcileNoProviders: '这一天还没有任何平台记录。',
        reconcileLoading: '正在读取当天记录…',
        reconcileLoadFailed: '读取失败：{error}',
        reconcileNote: '差额为正表示官方比插件多，常见于直连 API、重试、辅助调用或插件未运行时的请求；官方金额才是结算依据。',
        reconcilePlaceholderCalls: '如 27；可留空',
        reconcilePlaceholderCost: '如 12.8194',
        reconcilePlaceholderTokens: '如 133433467',
        reconcileRefresh: '重新读取',
        reconcileClose: '关闭',
        footerPrice: '平台行的「人工导入价格」可直接改；也可在「设置 → 插件 → dsh-billing-statistics」的配置 pricing 里改，或写进 profile 的 {file}。',
        footerFile: '数据文件（沿用历史兼容目录）：$DSH_HOME/{file}',
      },
      en: {
        nav: 'Billing stats',
        title: 'LLM billing statistics',
        subtitle: '{platforms} platforms · {models} models · updated {updated}',
        scopeNote: 'Counts are model request attempts, including retries and auxiliary calls such as titles and compaction.',
        scopeOnly: 'Only models called during the selected time range appear in this plugin.',
        rangeLabel: 'Range',
        rangeToday: 'Today',
        range7: '7 days',
        range30: '30 days',
        rangeAll: 'All',
        live: 'Auto refresh',
        liveHint: 'Refreshes every 5 seconds; paused while the page is in the background.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        reset: 'Clear data',
        confirmReset: 'Clear all recorded usage data? This cannot be undone.',
        retry: 'Retry',
        loading: 'Loading usage data…',
        failed: 'Could not load usage data.',
        stale: 'Last refresh failed: {error}',
        cardCalls: 'Calls',
        cardCallsHint: '{platforms} platforms · {models} models',
        cardTokens: 'Tokens',
        cardTokensHint: 'input {prompt} · output {output}',
        cardCost: 'Spend',
        cardCostHint: 'computed from models.dev / manual / DeepSeek official / configured prices, not an invoice',
        cardOk: 'Success',
        cardOkHint: '{failed} failed · {aborted} aborted',
        unpricedTitle: 'Some models have no price:',
        unpricedBody: '{models}. Their tokens are counted but not priced; add rates under the plugin config "pricing".',
        listSeparator: ', ',
        listMore: ' ({count} total)',
        statTokens: 'Tokens',
        statCost: 'Spend',
        colModel: 'Model',
        colCalls: 'Calls',
        colOk: 'Success',
        colInput: 'Input tokens',
        colInputHint: 'Input = uncached input + cache read + cache write',
        colOutput: 'Output tokens',
        colOutputHint: 'Output tokens include reasoning tokens',
        colCost: 'Spend',
        colCostHint: 'Estimated from the price table; not a provider invoice',
        colPrice: 'Cost data source',
        colPriceHint: '"models.dev" is the structured catalog price; "manual import" is entered here and wins over the catalog; "DeepSeek official" is the official API auto price; "configured" comes from plugin pricing; "built-in estimate" is the fallback',
        priceCustom: 'configured',
        priceCatalog: 'models.dev',
        priceManual: 'manual import',
        priceEstimate: 'built-in estimate',
        priceMissing: 'not set',
        priceOfficial: 'DeepSeek official',
        priceOfficialAuto: 'official auto price',
        priceOfficialLive: 'official live',
        priceOfficialCache: 'official cache',
        priceOfficialBuiltin: 'built-in official table',
        priceBannerOfficial: 'DeepSeek official prices: {providers} ({source}, last {time})',
        priceOfficialNote: 'This is the DeepSeek official API: official peak/off-peak prices are enabled automatically, read from the official site and converted to CNY. It applies only to the DeepSeek official API, never to other platforms. Opening the import dialog first tries the latest official site price and falls back to the built-in official table.',
        priceOfficialNoteTitle: 'DeepSeek official API auto price',
        priceOfficialLoading: 'Reading the latest DeepSeek official price…',
        priceOfficialLoaded: 'Loaded the latest official price ({source})',
        priceOfficialFallback: 'Official price lookup failed; using the built-in official table: {error}',
        priceOfficialNoModels: 'No matching official-price models right now',
        priceOfficialManualHint: 'Official prices already apply automatically; no save is needed. Edit below only for an override, which then wins.',
        priceLegacyManualNote: 'An older manual price was found. DeepSeek official pricing is active now; the old values remain below and become an override only if you save them.',
        sourceRestoreOfficial: 'Use official price',
        sourceRestoringOfficial: 'Restoring…',
        sourceOfficialRestored: 'Manual override removed; DeepSeek official auto price restored',
        sourceStatusOfficial: 'DeepSeek official auto price for {models} models (UTC peak)',
        sourceOfficialTag: 'DeepSeek official',
        rateInline: 'input {input} · output {output} · cache {cacheRead}',
        priceHours: '{from}–{to}',
        priceOtherWindow: 'other hours',
        monthAxis: '{month}',
        priceBanner: 'models.dev prices: {providers} (last {time})',
        priceBannerNever: 'No models.dev prices yet. Click "Refresh model prices"; models that cannot be matched can use "Manual import price".',
        priceBannerManual: 'Manual import price: {providers}',
        priceSync: 'Refresh model prices',
        priceSyncing: 'Looking up…',
        priceSynced: 'Updated prices for {models} models',
        priceSyncPartial: 'Some platforms unmatched: {providers}',
        priceSyncNone: 'Lookup failed: {error}',
        priceStale: 'not refreshed today',
        priceAutoNote: 'Prices come from models.dev / manual import / the official auto price; models.dev refreshes once a day.',
        priceManualOnly: 'Using manual import prices',
        priceDefaultWarn: 'You are using built-in / models.dev prices: API rates differ by platform, and models.dev has no peak-window prices. Use "Manual import price" to set them per platform.',
        priceCatalogSnapshot: 'models.dev refresh failed; using the bundled snapshot',
        priceCatalogCache: 'models.dev refresh failed; using the local cache',
        sourceCatalogTag: 'models.dev',
        sourceImportTag: 'manual import price',
        sourceStatusCatalog: 'models.dev matched {models} models',
        sourceStatusReference: 'models.dev reference price for {models} models ({provider})',
        sourceStatusManual: 'manual import price for {models} models',
        sourcePeakNote: 'Peak {window}',
        sourceStatusNone: 'models.dev matched none of these models; using built-in rules for now',
        sourceFailTitle: 'models.dev has no price for these models; built-in rules are used for now',
        sourceFailHint: 'Click "Manual import price" to enter rates; platforms or models not covered by models.dev are never priced automatically; the DeepSeek official API uses the official price table automatically.',
        sourceNote: 'Prices are looked up from models.dev; the DeepSeek official API automatically reads the official peak/off-peak table. If a model is unmatched or the price is wrong, click "Manual import price".',
        sourceResync: 'Look up again',
        sourceResyncOfficial: 'Refresh official price',
        sourceResyncing: 'Looking up…',
        sourceResynced: 'models.dev lookup refreshed',
        sourceOfficialRefreshed: 'Official price refreshed ({source})',
        sourceImport: 'Manual import price',
        sourceImportTitle: 'Manual price import',
        sourceImportHint: 'Enter rates for the models below. Blank fields keep their old price. CNY per 1M tokens; USD is also supported.',
        sourceImportTemplate: 'Download CSV template',
        sourceImportFile: 'Import from file',
        sourceImportFileHint: 'Use CSV / TSV: model, input, output, cache read, cache write; optional peak input, peak output, peak cache read, peak cache write. Fill it in Excel and import.',
        sourceImportFileInvalid: 'Invalid file: at least the columns "model, input, output, cache read, cache write" are required.',
        sourceImportFileDone: 'Loaded {models} models from the file; review and save.',
        sourceImportModel: 'Model',
        sourceImportInput: 'Input',
        sourceImportOutput: 'Output',
        sourceImportCacheRead: 'Cache read',
        sourceImportCacheWrite: 'Cache write',
        sourceImportPeakInput: 'Peak input',
        sourceImportPeakOutput: 'Peak output',
        sourceImportPeakCacheRead: 'Peak cache read',
        sourceImportPeakCacheWrite: 'Peak cache write',
        sourceImportPeak: 'Enable peak window',
        sourceImportPeakWindow: 'Peak window',
        sourceImportPeakPlaceholder: 'e.g. 09:00-12:00, 14:00-18:00',
        sourceImportPeakDays: 'Days',
        sourceImportDaysAll: 'Every day',
        sourceImportDaysWeekday: 'Weekdays',
        sourceImportDaysWeekend: 'Weekends',
        sourceImportDaysCustom: 'Custom (keep original)',
        sourceImportPeakHint: 'Whole hours only; 24:00 is allowed as the end. Models without peak prices still use the base price all day.',
        sourceImportPeakOffHint: 'When disabled, every model uses its base price all day.',
        sourceImportBaseTitle: 'Base price (outside peak)',
        sourceImportSingleTitle: 'Rate (all day)',
        sourceImportPeakTitle: 'Peak price (optional; blank = base price)',
        sourceImportPeakInvalid: 'Invalid peak window: use whole hours, e.g. 09:00-12:00, 14:00-18:00.',
        sourceImportModelPlaceholder: 'Model ID',
        sourceImportAdd: 'Add model',
        sourceImportRemove: 'Remove',
        sourceImportCurrency: 'Currency',
        sourceImportNote: 'Blank fields keep their old price; blanks on a new model become 0. Manual prices win over the official auto price, models.dev and built-in rules.',
        sourceImportInvalid: 'Prices must be non-negative numbers.',
        sourceImportEmpty: 'Enter a price for at least one model.',
        sourceImportSaving: 'Saving…',
        sourceImportConfirm: 'Save and recalculate',
        sourceImportCancel: 'Cancel',
        sourceImportSaved: 'Saved manual prices for {models} models',
        sourceImportFailed: 'Import failed: {error}',
        peakLabel: 'peak',
        offPeakLabel: 'off-peak',
        costSplit: 'peak {peak} · off {off}',
        tierNote: 'tiered by input length',
        windowAllDay: 'all day',
        priceTipTitle: 'Rates (CNY per 1M tokens; models.dev and DeepSeek official USD converted)',
        costHint: 'estimate',
        costFullHint: 'Show all 6 decimal places',
        costHideHint: 'Hide decimal places',
        modelCalls: '{calls} calls · last {last}',
        modelFailureNote: '{failed} failed · {aborted} aborted; failed calls may make spend appear low',
        modelCount: '{provider} · {models} models',
        colCache: 'Cache tokens',
        colCacheHint: 'Cache read tokens; cache write tokens are noted below',
        uncachedNote: 'uncached {tokens}',
        cacheWriteNote: 'write {tokens}',
        reasoningNote: 'incl. {tokens} thinking',
        failureDetail: '{failed} failed · {aborted} aborted',
        rateTitle: 'CNY per 1M tokens: input {input} · output {output} · cache {cacheRead}',
        trendTitle: 'Calls per day',
        trendTitleMonth: 'Calls per month',
        trendTitleYear: 'Calls per year',
        trendHint: 'Bar height is the call count; hover a bar for the date and spend',
        trendHintMonth: 'Bar height is the call count; hover a bar for the month and spend',
        trendHintYear: 'Bar height is the call count; hover a bar for the year and spend',
        trendRange: '{days} days · peak {peak} calls',
        trendRangePeriod: '{periods} periods · peak {peak} calls',
        trendBar: '{day}: {calls} calls · {tokens} tokens · {cost}',
        trendTipDay: '{day} {weekday}',
        trendTipPeriod: '{period}',
        trendTipCalls: '{calls} calls',
        trendTipTokens: '{tokens} tokens',
        trendTipCost: 'spend {cost}',
        trendTipSplit: 'peak {peak} · off {off}',
        trendTipEmpty: 'no calls on this day',
        trendTipEmptyPeriod: 'no calls in this period',
        weekdays: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat',
        detailTitle: 'Time detail',
        detailHint: 'Hourly tokens and spend for this model',
        detailToggle: 'Expand time detail',
        detailCollapse: 'Collapse time detail',
        detailLoading: 'Loading detail…',
        detailEmpty: 'no finer-grained records in this range',
        detailError: 'Failed to load detail: {error}',
        detailDay: 'Date',
        detailHour: 'Hour',
        detailSum: 'Total',
        detailTruncated: 'Showing the latest {count} buckets only',
        detailDayLabel: 'View date',
        detailToday: 'today',
        detailAllDays: 'All dates',
        detailDaySum: '{calls} calls · {tokens} tokens',
        detailDaySumCost: '{calls} calls · {tokens} tokens · {cost}',
        detailEmptyDay: 'No calls on this date',
        detailMonthTitle: 'Monthly detail',
        detailYearTitle: 'Yearly detail',
        detailMonthHint: 'Tokens and spend by month in {year}',
        detailYearHint: 'Tokens and spend by year',
        detailMonth: 'Month',
        detailYear: 'Year',
        empty: 'No model calls recorded yet.',
        emptyHint: 'Send a message in this Harness (or let a subagent or title generator call a model) and the numbers appear here.',
        footerRetention: 'Daily buckets are kept for {days} days; monthly totals are kept long term, switch years to browse them.',
        exportReport: 'Export report',
        exportHint: 'Open export settings: choose HTML / PDF, date range, and whether to include time detail.',
        exportTitle: 'Export report',
        exportFormat: 'Format',
        exportFormatHtml: 'HTML report',
        exportFormatPdf: 'PDF document',
        exportPdfHint: 'PDF uses a local Chinese font; switch to HTML if generation fails.',
        exportRange: 'Date range',
        exportRangeYear: 'Year {year}',
        exportDetail: 'Include time detail',
        exportDetailHint: 'Hourly for the daily view; monthly or yearly for year/all views.',
        exportDataWarning: 'Including hourly detail can add many rows; large datasets may produce a very large file. Enable only when needed.',
        exportFailed: 'Export failed: {error}',
        exportCancel: 'Cancel',
        exportConfirm: 'Export',
        exporting: 'Exporting…',
        reconcileOpen: 'Reconcile official bill',
        reconcileHint: 'Enter the official daily amount, call count, and more to compare with this plugin; no login is read.',
        reconcileTitle: 'Reconcile official bill',
        reconcileIntro: 'Official bills usually require a login to the provider platform (e.g. DeepSeek Platform), and providers do not expose a public billing API for plugins. This plugin does not store credentials or scrape pages. Copy the day totals from the official dashboard into the fields below. Leave the call count blank when the provider does not expose it.',
        reconcileProvider: 'Provider',
        reconcileDay: 'Date',
        reconcileOfficialCalls: 'Official calls (optional)',
        reconcileOfficialCost: 'Official amount (CNY)',
        reconcileOfficialTokens: 'Official tokens (optional)',
        reconcileLocal: 'Plugin record',
        reconcileOfficial: 'Official bill',
        reconcileDelta: 'Difference (official − plugin)',
        reconcileCalls: 'Calls',
        reconcileCost: 'Amount',
        reconcileTokens: 'Tokens',
        reconcileMissing: 'Official is higher; plugin missed calls',
        reconcileExtra: 'Official is lower; plugin overcounts',
        reconcileAligned: 'Aligned',
        reconcileEmptyDay: 'No plugin records on this date.',
        reconcileNoProviders: 'No provider records on this date yet.',
        reconcileLoading: 'Loading that day…',
        reconcileLoadFailed: 'Load failed: {error}',
        reconcileNote: 'A positive difference means the official bill is higher, often from direct API calls, retries, auxiliary calls, or requests made while the plugin was not running. The official bill is authoritative.',
        reconcilePlaceholderCalls: 'e.g. 27; optional',
        reconcilePlaceholderCost: 'e.g. 12.8194',
        reconcilePlaceholderTokens: 'e.g. 133433467',
        reconcileRefresh: 'Reload',
        reconcileClose: 'Close',
        footerPrice: 'Use "Manual import price" on a provider row, or edit config "pricing" under Settings → Plugins → dsh-billing-statistics, or in the profile {file}.',
        footerFile: 'Data file (legacy compatibility directory): $DSH_HOME/{file}',
      },
    }

    function translate(locale, snapshot) {
      const dict = dictionaries[snapshot?.active] ?? dictionaries.zh
      return (key, params) => {
        const template = dict[key] ?? dictionaries.zh[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (whole, name) =>
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
        )
      }
    }

    /** 取当前语言快照，语言切换时触发重渲染。 */
    function useLocaleSnapshot(locale) {
      const subscribe = useCallback((onChange) => locale.subscribe(onChange), [locale])
      const read = useCallback(() => locale.getSnapshot(), [locale])
      return useSyncExternalStore(subscribe, read)
    }

    /* --------------------------------- 样式 ---------------------------------- */

    const STYLE_ID = 'llmu-styles'
    const STYLES = `
.llmu-root {
  display: flex; flex-direction: column; gap: 16px; height: 100%; min-height: 0;
  padding: 20px 24px 32px; overflow-y: auto;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
}
/* 纵向 flex 容器里的直接子项不能被压缩：否则平台卡片会缩到只剩标题，
   展开后的表格被 overflow:hidden 裁掉（表现为「点展开看不到模型」）。 */
.llmu-root > * { flex: 0 0 auto; }
.llmu-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.llmu-head-main { flex: 1 1 260px; min-width: 0; }
.llmu-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
.llmu-sub { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.llmu-scope { display: block; margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.llmu-scope-em {
  margin-top: 7px; padding-left: 8px;
  font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary); opacity: 1;
  border-left: 2px solid var(--dsw-alias-border-l2);
}
.llmu-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.llmu-seg {
  display: inline-flex; align-items: center; padding: 2px; gap: 2px; flex-wrap: wrap;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
}
.llmu-seg button {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; padding: 6px 10px; border-radius: 6px; cursor: pointer;
}
.llmu-seg button:hover { color: var(--dsw-alias-label-primary); }
.llmu-seg button[data-active='true'] {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
}
.llmu-btn {
  appearance: none; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 1; padding: 7px 10px; cursor: pointer;
}
.llmu-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.llmu-btn:disabled { opacity: .55; cursor: default; }
.llmu-btn[data-tone='danger'] { color: var(--dsw-alias-state-error-primary); }
.llmu-price-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.llmu-price-text { flex: 1 1 320px; min-width: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.llmu-price-warn { flex: 1 1 100%; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); }
.llmu-badge { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 999px; font-style: normal; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.llmu-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.llmu-badge[data-tone="ok"], .llmu-badge[data-tone="good"] { color: var(--dsw-alias-state-success-primary); }
.llmu-source-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 12px 10px; }
.llmu-source-wrap { display: flex; flex-direction: column; }
.llmu-source-fail {
  margin: -4px 12px 10px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1);
  font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-error-primary);
}
.llmu-source-fail-title { font-weight: 600; }
.llmu-source-fail-detail { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
.llmu-source-partial { margin: -4px 12px 10px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-warn-primary); }
.llmu-source-tag { flex: none; padding: 1px 6px; border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.llmu-source-tag[data-origin='auto'] { color: var(--dsw-alias-state-warn-primary); }
.llmu-source-tag[data-origin='catalog'] { color: var(--dsw-alias-brand-primary); }
.llmu-source-tag[data-origin='official'] { color: var(--dsw-alias-state-success-primary); }
.llmu-source-tag[data-origin='manual-import'] { color: var(--dsw-alias-brand-primary); }
.llmu-source-input { flex: 1 1 260px; min-width: 0; height: 26px; padding: 0 8px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.llmu-source-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-source-status { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-source-peak { font-size: 10px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 1px 5px; }
.llmu-source-status[data-ok='false'] { color: var(--dsw-alias-state-warn-primary); }
.llmu-source-note { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.llmu-live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.llmu-live:hover { color: var(--dsw-alias-label-primary); }
.llmu-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.llmu-dot[data-on='true'] { background: var(--dsw-alias-state-success-primary); }
.llmu-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.llmu-card {
  display: flex; flex-direction: column; gap: 6px; padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
}
.llmu-card-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.llmu-card-value { font-size: 22px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.llmu-card-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.llmu-cost { display: inline-flex; align-items: baseline; gap: 4px; }
.llmu-cost-main { font-variant-numeric: tabular-nums; }
.llmu-cost-more {
  appearance: none; border: 0; background: transparent; margin: 0;
  padding: 0 2px; font: inherit; line-height: 1;
  color: var(--dsw-alias-label-secondary); cursor: pointer; border-radius: 4px;
  opacity: .35; transition: opacity .12s ease, color .12s ease;
}
.llmu-cost-eye { display: block; width: 13px; height: 13px; }
.llmu-cost:hover .llmu-cost-more, .llmu-cost-more:focus-visible { opacity: .9; }
.llmu-cost-more:hover { color: var(--dsw-alias-label-primary); }
.llmu-cost-more[aria-pressed='true'] { opacity: .9; color: var(--dsw-alias-label-primary); }
@media (hover: none) { .llmu-cost-more { opacity: .55; } }
.llmu-note {
  display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.llmu-note[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary); }
.llmu-note strong { font-weight: 600; }
.llmu-platforms { display: flex; flex-direction: column; gap: 20px; }
.llmu-platform {
  border: 1px solid var(--dsw-alias-border-l2); border-left-width: 3px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  overflow: hidden; flex: none;
}
.llmu-platform[data-open='true'] .llmu-platform-head { background: var(--dsw-alias-bg-layer-2); }
.llmu-platform-head {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 0; border: 0; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.llmu-platform-toggle {
  display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0;
  padding: 12px 0 12px 14px; border: 0; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.llmu-platform-head:hover { background: var(--dsw-alias-bg-layer-2); }
.llmu-caret { width: 14px; flex: none; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.llmu-caret[data-open='true'] { transform: rotate(90deg); }
.llmu-platform-name { flex: 1 1 auto; min-width: 0; }
.llmu-platform-name b { display: block; font-size: 14px; font-weight: 600; }
.llmu-platform-name span { display: block; margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-platform-stat { display: flex; gap: 18px; flex: none; font-size: 12px; padding-right: 14px; }
.llmu-platform-stat div { text-align: right; }
.llmu-platform-stat em { display: block; font-style: normal; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.llmu-platform-stat b { font-weight: 600; font-variant-numeric: tabular-nums; }
.llmu-table-wrap { overflow-x: auto; border-top: 1px solid var(--dsw-alias-border-l1); }
.llmu-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.llmu-table th, .llmu-table td { padding: 8px 12px; text-align: right; white-space: nowrap; }
.llmu-table th:first-child, .llmu-table td:first-child { text-align: left; }
.llmu-table thead th {
  font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.llmu-table tbody tr + tr td { border-top: 1px solid var(--dsw-alias-border-l1); }
.llmu-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }
.llmu-table td { font-variant-numeric: tabular-nums; }
.llmu-model { display: flex; flex-direction: row; align-items: flex-start; gap: 6px; max-width: 340px; }
.llmu-model-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.llmu-model-caret {
  flex: none; width: 12px; font-size: 10px; line-height: 1.7; color: var(--dsw-alias-label-secondary);
  transition: transform .12s ease; display: inline-block;
}
.llmu-model-caret[data-open='true'] { transform: rotate(90deg); }
.llmu-model-row { cursor: pointer; }
.llmu-model-row[data-open='true'] > td { background: var(--dsw-alias-bg-layer-2); }
.llmu-model-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.llmu-model-text b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llmu-model-text span { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.llmu-detail-row > td { padding: 0; background: var(--dsw-alias-bg-base); }
.llmu-detail { padding: 10px 12px 12px 32px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.llmu-period { padding: 0; border-top: 0; }
.llmu-detail-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.llmu-detail-head b { font-size: 12px; font-weight: 600; }
.llmu-detail-head span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-detail-note { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); padding: 2px 0; }
.llmu-detail-note.llmu-error { color: var(--dsw-alias-state-error-primary); }
.llmu-detail-days { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-detail-days-label { flex: none; }
.llmu-detail-select {
  font: inherit; font-size: 11px; padding: 2px 6px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit;
}
.llmu-detail-daysum { margin-left: auto; }
.llmu-detail-scroll { max-height: 262px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.llmu-detail-table { font-size: 11px; }
.llmu-detail-table th, .llmu-detail-table td { padding: 6px 10px; }
.llmu-detail-table thead th { position: sticky; top: 0; z-index: 1; }
.llmu-detail-table tfoot td { font-weight: 600; background: var(--dsw-alias-bg-layer-1); }
.llmu-detail-table tbody tr[data-day-start='true'] td { border-top: 1px solid var(--dsw-alias-border-l1); }
.llmu-model b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.llmu-model span { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.llmu-suffix { margin-left: 4px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.llmu-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 42px 16px;
  border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; line-height: 1.7;
}
.llmu-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.llmu-foot { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.llmu-export {
  appearance: none; border: 0; background: transparent; padding: 0; font: inherit;
  color: var(--dsw-alias-label-primary); text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.llmu-export:hover { color: var(--dsw-alias-brand-primary); }
.llmu-modal {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 20px; background: rgba(15, 23, 42, .32);
}
.llmu-dialog {
  width: min(430px, 100%); padding: 18px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); box-shadow: 0 18px 48px rgba(15, 23, 42, .22);
}
.llmu-dialog-title { margin: 0 0 14px; font-size: 16px; font-weight: 600; }
.llmu-dialog-wide { width: min(760px, 100%); max-height: calc(100vh - 40px); overflow-y: auto; }
.llmu-import-table-wrap { max-height: 42vh; overflow: auto; margin-top: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }
.llmu-import-table-half { max-height: 26vh; }
.llmu-official-note { margin: 8px 0 4px; padding: 9px 11px; border-left: 3px solid var(--dsw-alias-state-success-primary); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.llmu-official-note strong { display: block; margin-bottom: 2px; color: var(--dsw-alias-label-primary); }
.llmu-official-note p { margin: 0; }
.llmu-import-file-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.llmu-import-file-row label { cursor: pointer; }
.llmu-import-file-note { margin: 6px 0 0; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-success-primary); }
.llmu-peak-row { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; margin-top: 12px; }
.llmu-peak-toggle { display: flex; align-items: center; gap: 7px; height: 30px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.llmu-peak-toggle input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.llmu-peak-field { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-peak-field .llmu-select { width: 128px; }
.llmu-import-peak-input { width: 300px; max-width: 100%; height: 30px; padding: 0 8px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; box-sizing: border-box; }
.llmu-import-peak-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-import-section-title { margin: 14px 0 6px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.llmu-import-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.llmu-import-table th { position: sticky; top: 0; z-index: 1; padding: 7px 8px; text-align: left; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.llmu-import-table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
.llmu-import-table tr:last-child td { border-bottom: none; }
.llmu-import-model { display: block; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.llmu-import-model-input { width: 100%; min-width: 180px; height: 26px; padding: 0 7px; font: 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; box-sizing: border-box; }
.llmu-import-model-input:focus, .llmu-import-num:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-import-num { width: 78px; height: 26px; padding: 0 6px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; box-sizing: border-box; }
.llmu-btn-compact { height: 24px; padding: 0 8px; font-size: 11px; }
.llmu-import-input {
  width: 100%; min-height: 168px; padding: 9px 10px; resize: vertical;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; box-sizing: border-box;
}
.llmu-import-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-import-error { margin: 8px 0 0; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); }
.llmu-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.llmu-select {
  width: 100%; height: 30px; padding: 0 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
}
.llmu-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-export-note { margin: 5px 0 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.llmu-check { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; font-size: 12px; cursor: pointer; }
.llmu-check input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.llmu-check strong { display: block; font-weight: 500; }
.llmu-check em { display: block; margin-top: 2px; font-style: normal; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-export-warning { margin: 6px 0 0 24px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); }
.llmu-reconcile-intro { margin: 0 0 10px; font-size: 11px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.llmu-reconcile-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.llmu-reconcile-official { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.llmu-reconcile-fields .llmu-field, .llmu-reconcile-official .llmu-field { margin-top: 0; min-width: 0; }
.llmu-reconcile-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
.llmu-reconcile-table th, .llmu-reconcile-table td { padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.llmu-reconcile-table th:first-child, .llmu-reconcile-table td:first-child { text-align: left; }
.llmu-reconcile-table thead th { font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.llmu-reconcile-table tbody tr:last-child td { border-bottom: none; }
.llmu-reconcile-muted { color: var(--dsw-alias-label-secondary); }
.llmu-reconcile-delta[data-tone='missing'] { color: var(--dsw-alias-state-warn-primary); }
.llmu-reconcile-delta[data-tone='extra'] { color: var(--dsw-alias-brand-primary); }
.llmu-reconcile-delta[data-tone='aligned'] { color: var(--dsw-alias-state-success-primary); }
.llmu-reconcile-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.llmu-reconcile-state { padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; }
.llmu-reconcile-state[data-tone='missing'] { color: var(--dsw-alias-state-warn-primary); }
.llmu-reconcile-state[data-tone='extra'] { color: var(--dsw-alias-brand-primary); }
.llmu-reconcile-state[data-tone='aligned'] { color: var(--dsw-alias-state-success-primary); }
.llmu-reconcile-note { margin: 10px 0 0; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
@media (max-width: 560px) {
  .llmu-reconcile-official { grid-template-columns: 1fr; }
}
.llmu-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.llmu-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.llmu-trend {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  width: 100%; max-width: 708px;
}
.llmu-trend-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.llmu-trend-head b { font-size: 12px; font-weight: 600; }
.llmu-trend-head span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-trend-body { max-width: 100%; }
.llmu-bars { display: flex; align-items: flex-end; gap: 2px; height: 88px; padding-top: 4px; position: relative; }
.llmu-bar-slot { position: relative; flex: 1 1 0; height: 100%; display: flex; align-items: flex-end; min-width: 2px; border-radius: 3px; }
.llmu-bar {
  width: 100%; max-width: 26px; margin: 0 auto; border-radius: 3px 3px 0 0; background: var(--dsw-alias-brand-primary);
  opacity: .82; min-height: 2px; transition: opacity .12s ease;
}
.llmu-bar[data-empty='true'] { background: var(--dsw-alias-state-idle-primary); opacity: .3; }
.llmu-bar-slot:hover .llmu-bar, .llmu-bar[data-active='true'] { opacity: 1; }
.llmu-bar[data-active='true'] { box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.llmu-tip {
  position: absolute; left: 50%; top: 6px; transform: translateX(-50%);
  z-index: 6; pointer-events: none; min-width: 128px; max-width: 220px;
  padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.55; white-space: nowrap;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 20px rgba(0, 0, 0, .18); text-align: left;
}
.llmu-tip strong { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 600; }
.llmu-tip div { color: var(--dsw-alias-label-secondary); }
.llmu-tip .llmu-tip-cost { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.llmu-bar-slot:first-child .llmu-tip { left: 0; transform: none; }
.llmu-bar-slot:last-child .llmu-tip { left: auto; right: 0; transform: none; }
.llmu-bar-slot:only-child .llmu-tip { left: 0; right: auto; transform: none; }
.llmu-axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.llmu-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`

    function StyleTag() {
      return h('style', { 'data-llmu': STYLE_ID, dangerouslySetInnerHTML: { __html: STYLES } })
    }

    /* --------------------------------- 数字格式 --------------------------------- */

    // 数字格式跟随界面语言：中文用「万/亿」，英文用 K/M/B。
    const NUMBER_LOCALES = { zh: 'zh-CN', en: 'en-US' }
    const COMPACT_UNITS = {
      zh: [
        { size: 1e8, suffix: '亿' },
        { size: 1e4, suffix: '万' },
      ],
      en: [
        { size: 1e9, suffix: 'B' },
        { size: 1e6, suffix: 'M' },
        { size: 1e3, suffix: 'K' },
      ],
    }
    let activeNumberLocale = NUMBER_LOCALES.zh
    function localeTagOf(language) {
      return String(language ?? '').startsWith('en') ? NUMBER_LOCALES.en : NUMBER_LOCALES.zh
    }
    function formatInteger(value, localeTag = activeNumberLocale) {
      return (Number(value) || 0).toLocaleString(localeTag, { maximumFractionDigits: 0 })
    }

    function formatCompact(value, localeTag = activeNumberLocale) {
      const n = Number(value) || 0
      if (Math.abs(n) < 1000) return String(Math.round(n))
      const units = COMPACT_UNITS[localeTag === NUMBER_LOCALES.en ? 'en' : 'zh']
      for (const unit of units) {
        if (Math.abs(n) >= unit.size) {
          const scaled = n / unit.size
          return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2).replace(/\.0+$/, '')}${unit.suffix}`
        }
      }
      return String(Math.round(n))
    }

    /** 去掉小数末尾多余的 0，但保留整数部分（"16.8876" 保持，"1.5000" → "1.5"）。 */
    function trimZeros(text) {
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
    }

    /**
     * 金额展示（默认精度，像被遮住的小数）：
     * - <100 元：3 位（¥16.888 / ¥0.192）
     * - ≥100 元：2 位（¥123.45）
     * - ≥1000 元：1 位（¥1234.5）
     * 末尾多余的 0 会去掉。
     */
    function formatCost(value) {
      const n = Number(value) || 0
      if (n === 0) return '¥0'
      if (n >= 1000) return `¥${trimZeros(n.toFixed(1))}`
      if (n >= 100) return `¥${trimZeros(n.toFixed(2))}`
      return `¥${trimZeros(n.toFixed(3))}`
    }

    /** 完整金额：账本精度 6 位小数，点「眼睛」后替换显示（¥16.887587 / ¥0.191719）。 */
    function formatExactCost(value) {
      const n = Number(value) || 0
      if (n === 0) return '¥0'
      return `¥${trimZeros(n.toFixed(6))}`
    }

    /** 眼睛图标：显示时为睁开，展开完整小数时为闭眼（与密码可见性按钮同语义）。 */
    function CostEye({ open }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          className: 'llmu-cost-eye',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z' }),
        h('circle', { cx: 8, cy: 8, r: 2.1 }),
        open ? h('path', { d: 'M2.4 13.6 13.6 2.4' }) : null,
      )
    }

    /**
     * 金额 + 一个极小的「显示/隐藏小数」眼睛按钮。
     * 默认只显示 1~3 位（按金额大小）；点一下把小数值换成 6 位完整金额，再点恢复——
     * 与密码框「点一下显示明文」是同一交互，不额外占位、不跳行。
     */
    function CostValue({ t, value, known = true }) {
      const [open, setOpen] = useState(false)
      if (!known) return '—'
      return h(
        'span',
        { className: 'llmu-cost', 'data-open': open ? 'true' : 'false' },
        h('span', { className: 'llmu-cost-main' }, open ? formatExactCost(value) : formatCost(value)),
        h(
          'button',
          {
            type: 'button',
            className: 'llmu-cost-more',
            title: t(open ? 'costHideHint' : 'costFullHint'),
            'aria-label': t(open ? 'costHideHint' : 'costFullHint'),
            'aria-pressed': open ? 'true' : 'false',
            onClick: (event) => {
              event.stopPropagation()
              setOpen((current) => !current)
            },
          },
          h(CostEye, { open }),
        ),
      )
    }

    function formatTime(timestamp) {
      const value = Number(timestamp)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function percentText(calls, failed) {
      if (!calls) return '—'
      const ok = calls - failed
      return `${((ok / calls) * 100).toFixed(ok / calls >= 0.999 ? 0 : 1)}%`
    }

    /* ----------------------------------- 取数 ---------------------------------- */

    async function fetchSummary(range) {
      // range 是数字天（0 = 全部）或年份字符串（该年按月）。
      const query =
        typeof range === 'string' ? new URLSearchParams({ year: range }) : new URLSearchParams({ days: String(range) })
      const response = await fetch(`${API_BASE}/summary?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload
    }

    /** 官方账单对齐：某一天按平台汇总的插件记录。 */
    async function fetchDayTotals(day) {
      const query = new URLSearchParams({ day })
      const response = await fetch(`${API_BASE}/reconcile?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload
    }

    /** 某平台某模型的明细；同一个 key 缓存 60 秒，避免反复展开时重复请求。 */
    const detailCache = new Map()

    async function fetchModelDetail(provider, model, days) {
      const windowDays = Number.isFinite(Number(days)) ? Number(days) : 0
      const key = `${provider}|${model}|${windowDays}`
      const cached = detailCache.get(key)
      if (cached && Date.now() - cached.at < 60_000) return cached.data
      // 0 交给 Host 解释为「全部」，不再假装成 3660 天。
      const query = new URLSearchParams({ provider, model, days: String(windowDays) })
      const response = await fetch(`${API_BASE}/model?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      detailCache.set(key, { at: Date.now(), data: payload })
      return payload
    }

    async function resetUsage() {
      const response = await fetch(`${API_BASE}/reset`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload
    }

    /** 触发 Host 刷新 models.dev 目录并重算；返回同步报告。 */
    async function syncPriceTable() {
      const response = await fetch(`${API_BASE}/prices/sync`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload.prices
    }


    /** 人工导入某个平台的价格表，Host 会持久化并重算历史花费。 */
    async function importPriceTable(provider, currency, models, peak = null, officialOverride = false) {
      const response = await fetch(`${API_BASE}/prices/import`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ provider, currency, models, peak, officialOverride }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload.prices
    }

    /** 清掉某平台的旧人工价，让官方 API 恢复官方自动价。 */
    async function clearPriceTable(provider) {
      const response = await fetch(`${API_BASE}/prices/import`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ provider, clear: true }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload.prices
    }

    /* ---------------------------------- 小部件 ---------------------------------- */

    function SidebarIcon(props) {
      const size = Number(props?.size) || 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 20V11' }),
        h('path', { d: 'M10 20V4' }),
        h('path', { d: 'M16 20v-7' }),
        h('path', { d: 'M21 20H3' }),
      )
    }

    function Card({ label, value, hint }) {
      return h(
        'div',
        { className: 'llmu-card' },
        h('div', { className: 'llmu-card-label' }, label),
        h('div', { className: 'llmu-card-value' }, value),
        hint ? h('div', { className: 'llmu-card-hint' }, hint) : null,
      )
    }

    function Notice({ tone, children }) {
      return h('div', { className: 'llmu-note', 'data-tone': tone }, children)
    }

    /**
     * 价格条：显示 models.dev / DeepSeek 官方自动价已匹配的平台、目录时间与失败原因。
     * 「刷新模型价格」按钮在工具栏里（Host 每天自动刷新 models.dev；官方价每小时缓存）。
     */
    function PriceBanner({ t, prices, note }) {
      if (!prices) return null
      const entries = Array.isArray(prices.providers) ? prices.providers : []
      const official = entries.filter((entry) => entry.official && !entry.manual)
      const manual = entries.filter((entry) => entry.manual)
      const synced = entries.filter((entry) => entry.ok && !entry.official && !entry.manual)
      const errors = Array.isArray(prices.errors) ? prices.errors : []
      const names = (synced.length > 0 ? synced : official.length > 0 ? official : manual)
        .map((entry) => entry.title || entry.provider)
        .join(t('listSeparator'))
      const officialSource = official[0]?.officialSource
      const sourceLabel = officialSource === 'live'
        ? t('priceOfficialLive')
        : officialSource === 'cache'
          ? t('priceOfficialCache')
          : t('priceOfficialBuiltin')
      const fetchedAt = synced.length > 0
        ? Number(prices.fetchedAt) || Math.max(0, ...synced.map((entry) => Number(entry.fetchedAt) || 0))
        : Math.max(0, ...official.map((entry) => Number(entry.officialFetchedAt) || 0))
      const message = synced.length > 0
        ? t('priceBanner', { providers: names, time: formatTime(fetchedAt) })
        : official.length > 0
          ? t('priceBannerOfficial', { providers: names, source: sourceLabel, time: formatTime(fetchedAt) })
          : manual.length > 0
            ? t('priceBannerManual', { providers: names })
            : t('priceBannerNever')
      // 服务端已经算好“当前调用的模型是否都有人工/官方价”；旧响应没有这个字段时保留旧逻辑。
      const usesDefault = entries.some((entry) => {
        if (typeof entry.usingDefault === 'boolean') return entry.usingDefault
        if (entry.official) return false
        if (!entry.manual) return entry.origin === 'catalog' || !entry.origin
        return Number(entry.models) > Number(entry.manualModels)
      })
      return h(
        'div',
        { className: 'llmu-price-bar' },
        h(
          'span',
          { className: 'llmu-price-text' },
          message,
          prices.stale && synced.length > 0 ? h('em', { className: 'llmu-badge', 'data-tone': 'warn' }, t('priceStale')) : null,
          official.length > 0
            ? h(
                'em',
                { className: 'llmu-badge', 'data-tone': 'good', title: t('priceOfficialNote') },
                `${t('priceOfficialAuto')} · ${sourceLabel}`,
              )
            : null,
          h(
            'em',
            { className: 'llmu-badge' },
            synced.length > 0 ? t('priceAutoNote') : official.length > 0 ? null : t('priceManualOnly'),
          ),
          prices.catalogError && prices.catalogSource
            ? h(
                'em',
                { className: 'llmu-badge', 'data-tone': 'warn', title: String(prices.catalogError) },
                t(prices.catalogSource === 'snapshot' ? 'priceCatalogSnapshot' : 'priceCatalogCache'),
              )
            : null,
          errors.length > 0
            ? h(
                'em',
                { className: 'llmu-badge', 'data-tone': 'warn' },
                t('priceSyncPartial', {
                  providers: errors.map((entry) => entry.title || entry.provider).join(t('listSeparator')),
                }),
              )
            : null,
          note ? h('em', { className: 'llmu-badge', 'data-tone': note.tone }, note.text) : null,
        ),
        usesDefault ? h('div', { className: 'llmu-price-warn' }, t('priceDefaultWarn')) : null,
      )
    }

    /** 峰时时段格式化成输入框文本。 */
    function formatPeakText(peak) {
      return (peak?.ranges ?? [])
        .map(([from, to]) => `${String(from).padStart(2, '0')}:00-${String(to).padStart(2, '0')}:00`)
        .join(', ')
    }

    function officialSourceText(t, source) {
      if (source === 'live') return t('priceOfficialLive')
      if (source === 'cache') return t('priceOfficialCache')
      return t('priceOfficialBuiltin')
    }

    /** 解析「09:00-12:00, 14:00-18:00」；空文本返回空数组，格式错返回 null。 */
    function parsePeakText(text) {
      const cleaned = String(text ?? '').trim().replace(/[，、;；]/g, ',').replace(/\s+/g, '')
      if (!cleaned) return []
      const ranges = []
      for (const part of cleaned.split(',')) {
        const match = /^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/.exec(part)
        if (!match) return null
        const from = Number(match[1])
        const fromMinute = Number(match[2] ?? 0)
        const to = Number(match[3])
        const toMinute = Number(match[4] ?? 0)
        if (fromMinute !== 0 || toMinute !== 0) return null
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 24 || from >= to) return null
        if (!ranges.some(([a, b]) => a === from && b === to)) ranges.push([from, to])
      }
      return ranges.sort((a, b) => a[0] - b[0])
    }

    function peakDaysMode(peak) {
      const days = Array.isArray(peak?.days) ? peak.days : null
      if (!days || days.length === 0 || days.length === 7) return 'all'
      const set = new Set(days)
      if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return 'weekday'
      if (set.size === 2 && set.has(0) && set.has(6)) return 'weekend'
      return 'custom'
    }

    /** 人工导入价格：直接给当前模型逐行填单价，留空字段表示保留旧价。 */
    function manualRowsFor(entry, models) {
      const ids = []
      for (const id of models ?? []) if (id) ids.push(String(id))
      for (const id of Object.keys(entry?.manualPrices ?? {})) if (!ids.includes(id)) ids.push(id)
      const unique = [...new Set(ids)]
      const hasPeak = Boolean(entry?.peak?.ranges?.length)
      const rows = unique.map((id) => {
        const old = entry?.manualPrices?.[id] ?? {}
        return {
          id,
          input: old.input === undefined ? '' : String(old.input),
          output: old.output === undefined ? '' : String(old.output),
          cacheRead: old.cacheRead === undefined ? '' : String(old.cacheRead),
          cacheWrite: old.cacheWrite === undefined ? '' : String(old.cacheWrite),
          peakInput: hasPeak && old.peakInput ? String(old.peakInput) : '',
          peakOutput: hasPeak && old.peakOutput ? String(old.peakOutput) : '',
          peakCacheRead: hasPeak && old.peakCacheRead ? String(old.peakCacheRead) : '',
          peakCacheWrite: hasPeak && old.peakCacheWrite ? String(old.peakCacheWrite) : '',
        }
      })
      const empty = { id: '', input: '', output: '', cacheRead: '', cacheWrite: '', peakInput: '', peakOutput: '', peakCacheRead: '', peakCacheWrite: '' }
      return rows.length > 0 ? rows : [empty]
    }

    function ManualImportDialog({ t, provider, entry, models, onCancel, onImported }) {
      const [rows, setRows] = useState(() => manualRowsFor(entry, models))
      const [currency, setCurrency] = useState(entry?.currency === 'USD' ? 'USD' : 'CNY')
      const [peakOn, setPeakOn] = useState(Boolean(entry?.peak?.ranges?.length))
      const [peakText, setPeakText] = useState(() => formatPeakText(entry?.peak))
      const [peakDays, setPeakDays] = useState(() => peakDaysMode(entry?.peak))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [fileNote, setFileNote] = useState('')
      const [officialStatus, setOfficialStatus] = useState(entry?.official && !entry?.manual ? 'loading' : 'idle')
      const [officialError, setOfficialError] = useState('')
      const [officialSource, setOfficialSource] = useState(entry?.officialSource ?? '')
      const modelsRef = useRef(models)
      modelsRef.current = models
      const editedRef = useRef(false)

      useEffect(() => {
        if (!entry?.official || entry?.manual) return undefined
        let cancelled = false
        setOfficialStatus('loading')
        setOfficialError('')
        ;(async () => {
          try {
            const response = await fetch(`${API_BASE}/prices/official?provider=${encodeURIComponent(provider)}&refresh=1`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (cancelled) return
            const officialRows = payload?.rows && typeof payload.rows === 'object' ? payload.rows : {}
            const activeModels = Array.isArray(modelsRef.current) ? modelsRef.current.map(String) : []
            const payloadModels = Array.isArray(payload?.models) ? payload.models.map(String) : []
            // 官方价表是内置/官网全量模型；当前调用过的模型排在前面，但不要只显示它一个。
            const known = [...new Set([...activeModels, ...payloadModels, ...Object.keys(officialRows)])]
            const nextRows = []
            for (const id of known) {
              const rate = officialRows[id]
              if (!rate) continue
              const stringOf = (value) => (value === undefined || value === null ? '' : String(value))
              nextRows.push({
                id,
                input: stringOf(rate.input),
                output: stringOf(rate.output),
                cacheRead: stringOf(rate.cacheRead),
                cacheWrite: stringOf(rate.cacheWrite),
                peakInput: stringOf(rate.peakInput),
                peakOutput: stringOf(rate.peakOutput),
                peakCacheRead: stringOf(rate.peakCacheRead),
                peakCacheWrite: stringOf(rate.peakCacheWrite),
              })
            }
            if (nextRows.length > 0) {
              if (!editedRef.current) {
                setRows(nextRows)
                setCurrency('USD')
                setPeakOn(true)
                if (payload?.plan?.ranges?.length) {
                  setPeakText(formatPeakText(payload.plan))
                  setPeakDays(peakDaysMode(payload.plan))
                }
              }
              setOfficialStatus(payload?.error ? 'fallback' : 'loaded')
              setOfficialSource(String(payload?.source ?? ''))
              setOfficialError(String(payload?.error ?? ''))
            } else {
              setOfficialStatus('fallback')
              setOfficialSource(String(payload?.source ?? ''))
              setOfficialError(String(payload?.error ?? t('priceOfficialNoModels')))
            }
          } catch (cause) {
            if (!cancelled) {
              setOfficialStatus('fallback')
              setOfficialSource('builtin')
              setOfficialError(String(cause?.message ?? cause))
            }
          }
        })()
        return () => {
          cancelled = true
        }
      }, [entry?.official, entry?.manual, provider])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [busy, onCancel])

      const patchRow = (index, key, value) => {
        editedRef.current = true
        setRows((current) => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
      }

      const removeRow = (index) => {
        editedRef.current = true
        setRows((current) => (current.length === 1 ? current : current.filter((_, i) => i !== index)))
      }

      const importFile = async (event) => {
        const input = event.target
        const file = input.files?.[0]
        input.value = ''
        if (!file) return
        setError('')
        setFileNote('')
        try {
          const parsed = parsePriceFile(await file.text())
          editedRef.current = true
          if (parsed.some((row) => [row.peakInput, row.peakOutput, row.peakCacheRead, row.peakCacheWrite].some((value) => String(value ?? '').trim()))) {
            setPeakOn(true)
          }
          setRows((current) => {
            const merged = new Map()
            const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'peakInput', 'peakOutput', 'peakCacheRead', 'peakCacheWrite']
            for (const row of current) {
              if (row.id.trim() || fields.some((key) => String(row[key] ?? '').trim())) {
                merged.set(row.id, row)
              }
            }
            for (const row of parsed) merged.set(row.id, row)
            return [...merged.values()]
          })
          setFileNote(t('sourceImportFileDone', { models: parsed.length }))
        } catch {
          setError(t('sourceImportFileInvalid'))
        }
      }

      const submit = async () => {
        if (busy) return
        let peak = null
        if (peakOn) {
          const ranges = parsePeakText(peakText)
          if (ranges === null || ranges.length === 0) {
            setError(t('sourceImportPeakInvalid'))
            return
          }
          peak = {
            ranges,
            days:
              peakDays === 'weekday'
                ? [1, 2, 3, 4, 5]
                : peakDays === 'weekend'
                  ? [0, 6]
                  : peakDays === 'custom' && Array.isArray(entry?.peak?.days)
                    ? entry.peak.days
                    : null,
          }
        }
        const prices = {}
        const fieldsOf = (row) => ['input', 'output', 'cacheRead', 'cacheWrite', 'peakInput', 'peakOutput', 'peakCacheRead', 'peakCacheWrite']
        for (const row of rows) {
          const id = row.id.trim()
          if (!id) continue
          const fields = fieldsOf(row).map((key) => String(row[key] ?? '').trim())
          if (fields.every((value) => value === '')) continue
          const old = entry?.manualPrices?.[id] ?? {}
          const numbers = fieldsOf(row).map((key, index) => {
            if (fields[index] !== '') return Number(fields[index])
            // 「留空 = 保持旧价」：老值存在时沿用老值；新模型没有旧值才按 0。
            const previous = Number(old[key])
            return Number.isFinite(previous) && previous >= 0 ? previous : 0
          })
          if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
            setError(t('sourceImportInvalid'))
            return
          }
          prices[id] = {
            input: numbers[0],
            output: numbers[1],
            cacheRead: numbers[2],
            cacheWrite: numbers[3],
            peakInput: peak ? numbers[4] : 0,
            peakOutput: peak ? numbers[5] : 0,
            peakCacheRead: peak ? numbers[6] : 0,
            peakCacheWrite: peak ? numbers[7] : 0,
          }
        }
        if (Object.keys(prices).length === 0) {
          setError(t('sourceImportEmpty'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const report = await importPriceTable(provider, currency, prices, peak, Boolean(entry?.official))
          if (report) onImported?.(report, Object.keys(prices).length)
        } catch (cause) {
          setError(t('sourceImportFailed', { error: String(cause?.message ?? cause) }))
        } finally {
          setBusy(false)
        }
      }

      const rateFields = ['input', 'output', 'cacheRead', 'cacheWrite']
      const peakFields = ['peakInput', 'peakOutput', 'peakCacheRead', 'peakCacheWrite']
      const renderRateTable = (fields, { peakTable = false, showActions = false } = {}) =>
        h(
          'div',
          { className: `llmu-import-table-wrap${peakOn ? ' llmu-import-table-half' : ''}` },
          h(
            'table',
            { className: 'llmu-import-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('sourceImportModel')),
                ...fields.map((key) => h('th', { key }, t(`sourceImport${key[0].toUpperCase()}${key.slice(1)}`))),
                h('th', null, ''),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((row, index) =>
                h(
                  'tr',
                  { key: `${peakTable ? 'p' : 'b'}-${index}` },
                  h(
                    'td',
                    null,
                    row.id
                      ? h('span', { className: 'llmu-import-model', title: row.id }, row.id)
                      : h('input', {
                          type: 'text',
                          className: 'llmu-import-model-input',
                          value: row.id,
                          placeholder: t('sourceImportModelPlaceholder'),
                          spellCheck: false,
                          disabled: busy,
                          onChange: (event) => patchRow(index, 'id', event.target.value),
                        }),
                  ),
                  ...fields.map((key) =>
                    h(
                      'td',
                      { key },
                      h('input', {
                        type: 'number',
                        min: '0',
                        step: 'any',
                        className: 'llmu-import-num',
                        value: row[key],
                        placeholder: '—',
                        disabled: busy,
                        onChange: (event) => patchRow(index, key, event.target.value),
                      }),
                    ),
                  ),
                  h(
                    'td',
                    null,
                    showActions
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'llmu-btn llmu-btn-compact',
                            disabled: busy,
                            onClick: () => removeRow(index),
                          },
                          t('sourceImportRemove'),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        )

      return h(
        'div',
        {
          className: 'llmu-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('sourceImportTitle'),
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        h(
          'div',
          { className: 'llmu-dialog llmu-dialog-wide' },
          h('h2', { className: 'llmu-dialog-title' }, t('sourceImportTitle')),
          h('p', { className: 'llmu-export-note' }, t('sourceImportHint')),
          h(
            'label',
            { className: 'llmu-field' },
            h('span', null, t('sourceImportCurrency')),
            h(
              'select',
              {
                className: 'llmu-select',
                value: currency,
                disabled: busy,
                onChange: (event) => setCurrency(event.target.value),
              },
              h('option', { value: 'CNY' }, 'CNY'),
              h('option', { value: 'USD' }, 'USD'),
            ),
          ),
          h(
            'div',
            { className: 'llmu-import-file-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'llmu-btn',
                disabled: busy,
                onClick: () => downloadText(priceTemplateCsv(rows), 'llm-usage-prices.csv'),
              },
              t('sourceImportTemplate'),
            ),
            h(
              'label',
              { className: 'llmu-btn' },
              t('sourceImportFile'),
              h('input', {
                type: 'file',
                accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values',
                disabled: busy,
                style: { display: 'none' },
                onChange: (event) => void importFile(event),
              }),
            ),
          ),
          h('p', { className: 'llmu-export-note' }, t('sourceImportFileHint')),
          fileNote ? h('p', { className: 'llmu-import-file-note' }, fileNote) : null,
          h(
            'div',
            { className: 'llmu-peak-row' },
            h(
              'label',
              { className: 'llmu-peak-toggle' },
              h('input', {
                type: 'checkbox',
                checked: peakOn,
                disabled: busy,
                onChange: (event) => setPeakOn(event.target.checked),
              }),
              t('sourceImportPeak'),
            ),
            peakOn
              ? h(
                  'label',
                  { className: 'llmu-peak-field' },
                  h('span', null, t('sourceImportPeakWindow')),
                  h('input', {
                    type: 'text',
                    className: 'llmu-import-peak-input',
                    value: peakText,
                    placeholder: t('sourceImportPeakPlaceholder'),
                    spellCheck: false,
                    disabled: busy,
                    onChange: (event) => setPeakText(event.target.value),
                  }),
                )
              : null,
            peakOn
              ? h(
                  'label',
                  { className: 'llmu-peak-field' },
                  h('span', null, t('sourceImportPeakDays')),
                  h(
                    'select',
                    {
                      className: 'llmu-select',
                      value: peakDays,
                      disabled: busy,
                      onChange: (event) => setPeakDays(event.target.value),
                    },
                    h('option', { value: 'all' }, t('sourceImportDaysAll')),
                    h('option', { value: 'weekday' }, t('sourceImportDaysWeekday')),
                    h('option', { value: 'weekend' }, t('sourceImportDaysWeekend')),
                    peakDays === 'custom' ? h('option', { value: 'custom' }, t('sourceImportDaysCustom')) : null,
                  ),
                )
              : null,
          ),
          h('p', { className: 'llmu-export-note' }, t(peakOn ? 'sourceImportPeakHint' : 'sourceImportPeakOffHint')),
          h('div', { className: 'llmu-import-section-title' }, t(peakOn ? 'sourceImportBaseTitle' : 'sourceImportSingleTitle')),
          renderRateTable(rateFields, { showActions: true }),
          peakOn
            ? h(
                'div',
                null,
                h('div', { className: 'llmu-import-section-title' }, t('sourceImportPeakTitle')),
                renderRateTable(peakFields, { peakTable: true }),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'llmu-btn',
              disabled: busy,
              onClick: () => {
                editedRef.current = true
                setRows((current) => [
                  ...current,
                  {
                    id: '',
                    input: '',
                    output: '',
                    cacheRead: '',
                    cacheWrite: '',
                    peakInput: '',
                    peakOutput: '',
                    peakCacheRead: '',
                    peakCacheWrite: '',
                  },
                ])
              },
            },
            t('sourceImportAdd'),
          ),
          h('p', { className: 'llmu-export-note' }, t('sourceImportNote')),
          entry?.official
            ? h(
                'div',
                { className: 'llmu-official-note' },
                h('strong', null, t('priceOfficialNoteTitle')),
                h('p', null, t('priceOfficialNote')),
                entry?.manual
                  ? h('p', { className: 'llmu-import-file-note' }, t('priceOfficialManualHint'))
                  : officialStatus === 'loading'
                    ? h('p', { className: 'llmu-import-file-note' }, t('priceOfficialLoading'))
                    : officialStatus === 'loaded'
                      ? h('p', { className: 'llmu-import-file-note' }, t('priceOfficialLoaded', { source: officialSourceText(t, officialSource) }))
                      : h(
                          'p',
                          { className: 'llmu-import-file-note' },
                          t('priceOfficialFallback', { error: officialError || t('priceOfficialBuiltin') }),
                        ),
              )
            : null,
          entry?.official && entry?.manualSaved && !entry?.manual
            ? h('p', { className: 'llmu-import-file-note' }, t('priceLegacyManualNote'))
            : null,
          error ? h('p', { className: 'llmu-import-error' }, error) : null,
          h(
            'div',
            { className: 'llmu-dialog-actions' },
            h('button', { type: 'button', className: 'llmu-btn', disabled: busy, onClick: onCancel }, t('sourceImportCancel')),
            h(
              'button',
              { type: 'button', className: 'llmu-btn llmu-btn-primary', disabled: busy, onClick: () => void submit() },
              busy ? t('sourceImportSaving') : t('sourceImportConfirm'),
            ),
          ),
        ),
      )
    }

    /** 平台价格行：自动从 models.dev 检索；DeepSeek 官方 API 另用官方价表；匹配不到时人工填价。 */
    function SourceRow({ t, provider, entry, models, onSaved }) {
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [importOpen, setImportOpen] = useState(false)

      useEffect(() => {
        setNote(null)
      }, [provider])

      const originTag = entry?.manual
        ? t('sourceImportTag')
        : entry?.official
          ? t('sourceOfficialTag')
          : entry?.catalogProvider
            ? t('sourceCatalogTag')
            : ''

      const status = entry?.manual
        ? t('sourceStatusManual', { models: entry.manualModels ?? entry.models })
        : entry?.official
          ? t('sourceStatusOfficial', { models: entry.officialModels ?? entry.models })
          : entry?.ok
            ? entry.reference
              ? t('sourceStatusReference', { models: entry.models, provider: entry.catalogProviderName || entry.catalogProvider || 'models.dev' })
              : t('sourceStatusCatalog', { models: entry.models })
            : entry?.missing
              ? t('sourceStatusNone')
              : entry?.error
                ? t('sourceStatusNone')
                : ''

      const resync = async () => {
        setBusy(true)
        setNote(null)
        try {
          if (entry?.official) {
            const response = await fetch(`${API_BASE}/prices/official?refresh=1&provider=${encodeURIComponent(provider)}`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            onSaved?.()
            setNote({
              tone: payload?.error ? 'warn' : 'ok',
              text: payload?.error
                ? t('priceOfficialFallback', { error: String(payload.error) })
                : t('sourceOfficialRefreshed', { source: officialSourceText(t, payload?.source) }),
            })
          } else {
            const report = await syncPriceTable()
            if (report) onSaved?.(report)
            setNote({ tone: 'ok', text: t('sourceResynced') })
          }
        } catch (cause) {
          setNote({ tone: 'warn', text: t('priceSyncNone', { error: String(cause?.message ?? cause) }) })
        } finally {
          setBusy(false)
        }
      }

      const restoreOfficial = async () => {
        setBusy(true)
        setNote(null)
        try {
          const report = await clearPriceTable(provider)
          onSaved?.(report)
          setNote({ tone: 'ok', text: t('sourceOfficialRestored') })
        } catch (cause) {
          setNote({ tone: 'warn', text: t('priceSyncNone', { error: String(cause?.message ?? cause) }) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'llmu-source-wrap' },
        h(
          'div',
          { className: 'llmu-source-row' },
          originTag
            ? h('span', { className: 'llmu-source-tag', 'data-origin': entry?.manual ? 'manual-import' : (entry?.origin ?? '') }, originTag)
            : null,
          h(
            'button',
            { type: 'button', className: 'llmu-btn', onClick: () => void resync(), disabled: busy },
            busy ? t('sourceResyncing') : entry?.official ? t('sourceResyncOfficial') : t('sourceResync'),
          ),
          h(
            'button',
            { type: 'button', className: 'llmu-btn llmu-btn-primary', onClick: () => setImportOpen(true), disabled: busy },
            t('sourceImport'),
          ),
          entry?.official && entry?.manualOverride
            ? h(
                'button',
                { type: 'button', className: 'llmu-btn', onClick: () => void restoreOfficial(), disabled: busy },
                busy ? t('sourceRestoringOfficial') : t('sourceRestoreOfficial'),
              )
            : null,
          status
            ? h(
                'span',
                {
                  className: 'llmu-source-status',
                  'data-ok': entry?.ok || entry?.manual ? 'true' : 'false',
                  title: entry?.catalogProvider
                    ? `${entry.catalogProviderName || entry.catalogProvider} / ${entry.catalogModel || ''}`
                    : undefined,
                },
                status,
              )
            : null,
          entry?.peak?.label
            ? h('span', { className: 'llmu-source-peak' }, t('sourcePeakNote', { window: entry.peak.label }))
            : null,
          note ? h('em', { className: 'llmu-badge', 'data-tone': note.tone }, note.text) : null,
        ),
        entry?.ok && entry?.error
          ? h('div', { className: 'llmu-source-partial' }, entry.error)
          : null,
        !entry?.ok && entry?.error
          ? h(
              'div',
              { className: 'llmu-source-fail' },
              h('div', { className: 'llmu-source-fail-title' }, t('sourceFailTitle')),
              h('div', null, t('sourceFailHint')),
              entry?.error ? h('div', { className: 'llmu-source-fail-detail' }, entry.error) : null,
            )
          : null,
        importOpen
          ? h(ManualImportDialog, {
              t,
              provider,
              entry,
              models,
              onCancel: () => setImportOpen(false),
              onImported: (report, count) => {
                if (report) onSaved?.(report)
                setImportOpen(false)
                setNote({ tone: 'ok', text: t('sourceImportSaved', { models: count }) })
              },
            })
          : null,
      )
    }

    function priceSourceText(t, model) {
      const source = model?.price?.source
      if (source === 'custom') return t('priceCustom')
      if (source === 'official') return t('priceOfficial')
      if (source === 'catalog') return t('priceCatalog')
      if (source === 'manual') return t('priceManual')
      if (source === 'estimate') return t('priceEstimate')
      return t('priceMissing')
    }

    function rateText(t, rate) {
      const value = rate ?? {}
      return t('rateInline', {
        input: value.input ?? 0,
        output: value.output ?? 0,
        cacheRead: value.cacheRead ?? 0,
      })
    }

    function periodDaysText(t, days) {
      if (!Array.isArray(days) || days.length === 0) return ''
      const set = new Set(days)
      if (set.size === 7) return t('sourceImportDaysAll')
      if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return t('sourceImportDaysWeekday')
      if (set.size === 2 && set.has(0) && set.has(6)) return t('sourceImportDaysWeekend')
      return [...set].sort((a, b) => a - b).join('、')
    }

    /** 价格明细（悬停提示）：时段 / 阶梯 + 单价。 */
    function priceWindowText(t, price) {
      const lines = [t('priceTipTitle')]
      for (const period of price?.periods ?? []) {
        const ranges = (period.ranges ?? [])
          .map(([from, to]) => t('priceHours', { from, to }))
          .join(t('listSeparator')) || t('windowAllDay')
        const days = periodDaysText(t, period.days)
        lines.push(`${days ? `${days} · ` : ''}${period.label ? `${period.label} · ` : ''}${ranges}：${rateText(t, period.rate)}`)
      }
      if (price?.defaultRate) lines.push(`${t('offPeakLabel')}（${t('priceOtherWindow')}）：${rateText(t, price.defaultRate)}`)
      for (const tier of price?.tiers ?? []) lines.push(`${tier.label || t('tierNote')}：${rateText(t, tier.rate)}`)
      if ((price?.periods?.length ?? 0) === 0 && (price?.tiers?.length ?? 0) === 0) lines.push(t('windowAllDay'))
      return lines.join('\n')
    }

    /** 价格是否带峰谷时段（用于把花费拆成峰/谷两段展示）。 */
    function hasTimeWindows(price) {
      const periods = price?.periods?.length ?? 0
      return periods > 1 || (periods === 1 && Boolean(price?.defaultRate))
    }

    /** 二次展开最多渲染多少段（只在「全部日期」时生效，避免 30 天 × 24 小时撑爆 DOM）。 */
    const DETAIL_MAX_ROWS = 400
    const ALL_DAYS = '__all__'

    /** 数据时区「今天」（YYYY-MM-DD），用于默认定位到当前日期。 */
    function beijingToday(utcOffsetHours = 8) {
      const offset = Number.isFinite(Number(utcOffsetHours)) ? Number(utcOffsetHours) : 8
      return new Date(Date.now() + offset * 3600 * 1000).toISOString().slice(0, 10)
    }

    /** 模型行二次展开后的按小时明细，点开时才去 Host 取数。 */
    function ModelDetail({ t, provider, model, days, showCost, utcOffsetHours = 8 }) {
      const [state, setState] = useState({ loading: true, error: '', data: null })

      useEffect(() => {
        let cancelled = false
        setState({ loading: true, error: '', data: null })
        fetchModelDetail(provider, model, days)
          .then((data) => {
            if (!cancelled) setState({ loading: false, error: '', data })
          })
          .catch((error) => {
            if (!cancelled) setState({ loading: false, error: String(error?.message ?? error), data: null })
          })
        return () => {
          cancelled = true
        }
      }, [provider, model, days])

      const totals = state.data?.totals
      const hours = state.data?.hours ?? []
      const today = beijingToday(utcOffsetHours)
      // 有数据的日期，新的在前；「全部日期」放最后。
      const dayOptions = useMemo(() => {
        const seen = new Set()
        for (const entry of hours) seen.add(entry.day)
        return [...seen].sort().reverse()
      }, [hours])
      const [selectedDay, setSelectedDay] = useState('')
      useEffect(() => {
        if (!state.data) return
        // 默认定位到今天；今天没数据就落到最近有数据的一天。
        setSelectedDay(dayOptions.includes(today) ? today : (dayOptions[0] ?? ''))
      }, [state.data])

      const truncated = selectedDay === ALL_DAYS && hours.length > DETAIL_MAX_ROWS
      const shown =
        selectedDay === ALL_DAYS
          ? truncated
            ? hours.slice(-DETAIL_MAX_ROWS)
            : hours
          : hours.filter((entry) => entry.day === selectedDay)
      const dayTotals = shown.reduce(
        (sum, entry) => {
          sum.calls += entry.calls ?? 0
          sum.tokens += entry.tokens?.total ?? 0
          sum.tokensPrompt += entry.tokens?.prompt ?? 0
          sum.tokensCache += entry.tokens?.cacheRead ?? 0
          sum.tokensOutput += entry.tokens?.output ?? 0
          sum.cost += entry.cost ?? 0
          return sum
        },
        { calls: 0, tokens: 0, tokensPrompt: 0, tokensCache: 0, tokensOutput: 0, cost: 0 },
      )
      // 表尾合计必须跟当前筛选一致：选某一天就合计这一天，只有「全部日期」才用整段汇总。
      const footerTotals = selectedDay === ALL_DAYS ? totals : dayTotals

      let body = h('div', { className: 'llmu-detail-note' }, t('detailLoading'))
      if (!state.loading && state.error) {
        body = h('div', { className: 'llmu-detail-note llmu-error' }, t('detailError', { error: state.error }))
      } else if (!state.loading && shown.length === 0) {
        body = h('div', { className: 'llmu-detail-note' }, state.data ? t('detailEmptyDay') : t('detailEmpty'))
      } else if (!state.loading) {
        body = h(
          'div',
          { className: 'llmu-detail-scroll' },
          h(
            'table',
            { className: 'llmu-table llmu-detail-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, t('detailDay')),
                h('th', { scope: 'col' }, t('detailHour')),
                h('th', { scope: 'col' }, t('colCalls')),
                h('th', { scope: 'col', title: t('colInputHint') }, t('colInput')),
                h('th', { scope: 'col', title: t('colCacheHint') }, t('colCache')),
                h('th', { scope: 'col', title: t('colOutputHint') }, t('colOutput')),
                showCost ? h('th', { scope: 'col', title: t('colCostHint') }, t('colCost')) : null,
              ),
            ),
            h(
              'tbody',
              null,
              shown.map((entry, index) => {
                const dayStart = index === 0 || shown[index - 1].day !== entry.day
                return h(
                  'tr',
                  { key: `${entry.day}-${entry.hour}`, 'data-day-start': dayStart ? 'true' : 'false' },
                  h('td', null, dayStart ? entry.day : ''),
                  h('td', null, `${String(entry.hour).padStart(2, '0')}:00`),
                  h('td', null, formatInteger(entry.calls)),
                  h('td', null, formatCompact(entry.tokens?.prompt ?? 0)),
                  h('td', null, formatCompact(entry.tokens?.cacheRead ?? 0)),
                  h('td', null, formatCompact(entry.tokens?.output ?? 0)),
                  showCost
                    ? h(
                        'td',
                        null,
                        h(CostValue, { t, value: entry.cost ?? 0 }),
                        (entry.peakCost ?? 0) > 0 && (entry.cost ?? 0) - (entry.peakCost ?? 0) > 0.0001
                          ? h(
                              'span',
                              { className: 'llmu-suffix' },
                              t('costSplit', {
                                peak: formatCost(entry.peakCost ?? 0),
                                off: formatCost(Math.max(0, (entry.cost ?? 0) - (entry.peakCost ?? 0))),
                              }),
                            )
                          : null,
                      )
                    : null,
                )
              }),
            ),
            footerTotals
              ? h(
                  'tfoot',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', null, t('detailSum')),
                    h('td', null, ''),
                    h('td', null, formatInteger(footerTotals.calls ?? 0)),
                    h('td', null, formatCompact(footerTotals.tokensPrompt ?? footerTotals.tokens?.prompt ?? 0)),
                    h('td', null, formatCompact(footerTotals.tokensCache ?? footerTotals.tokens?.cacheRead ?? 0)),
                    h('td', null, formatCompact(footerTotals.tokensOutput ?? footerTotals.tokens?.output ?? 0)),
                    showCost ? h('td', null, h(CostValue, { t, value: footerTotals.cost ?? 0 })) : null,
                  ),
                )
              : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'llmu-detail' },
        h(
          'div',
          { className: 'llmu-detail-head' },
          h('b', null, t('detailTitle')),
          h('span', null, t('detailHint')),
          truncated ? h('span', null, t('detailTruncated', { count: DETAIL_MAX_ROWS })) : null,
        ),
        !state.loading && !state.error && dayOptions.length > 0
          ? h(
              'div',
              { className: 'llmu-detail-days' },
              h('label', { className: 'llmu-detail-days-label' }, t('detailDayLabel')),
              h(
                'select',
                {
                  className: 'llmu-detail-select',
                  value: selectedDay,
                  onChange: (event) => setSelectedDay(event.target.value),
                },
                dayOptions.map((day) =>
                  h('option', { key: day, value: day }, day === today ? `${day} · ${t('detailToday')}` : day),
                ),
                h('option', { key: ALL_DAYS, value: ALL_DAYS }, t('detailAllDays')),
              ),
              selectedDay !== ALL_DAYS && dayTotals.calls > 0
                ? h(
                    'span',
                    { className: 'llmu-detail-daysum' },
                    showCost
                      ? t('detailDaySumCost', {
                          calls: formatInteger(dayTotals.calls),
                          tokens: formatCompact(dayTotals.tokens),
                          cost: formatCost(dayTotals.cost),
                        })
                      : t('detailDaySum', {
                          calls: formatInteger(dayTotals.calls),
                          tokens: formatCompact(dayTotals.tokens),
                        }),
                  )
                : null,
            )
          : null,
        body,
      )
    }

    /** 年 / 全部视图下的按月、按年明细；数据已经在 summary 里，不再单独请求。 */
    function PeriodDetail({ t, grain, year, rows, showCost, standalone = false }) {
      const list = useMemo(() => {
        if (grain !== 'month') return rows ?? []
        const byMonth = new Map((rows ?? []).map((entry) => [entry.month, entry]))
        return Array.from({ length: 12 }, (_, index) => {
          const month = `${year}-${String(index + 1).padStart(2, '0')}`
          return (
            byMonth.get(month) ?? {
              month,
              calls: 0,
              failed: 0,
              aborted: 0,
              tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, prompt: 0, total: 0 },
              cost: 0,
              peakCost: 0,
            }
          )
        })
      }, [grain, year, rows])

      const totals = list.reduce(
        (sum, entry) => {
          sum.calls += entry.calls ?? 0
          sum.failed += entry.failed ?? 0
          sum.aborted += entry.aborted ?? 0
          sum.tokensPrompt += entry.tokens?.prompt ?? 0
          sum.tokensCache += entry.tokens?.cacheRead ?? 0
          sum.tokensOutput += entry.tokens?.output ?? 0
          sum.cost += entry.cost ?? 0
          return sum
        },
        { calls: 0, failed: 0, aborted: 0, tokensPrompt: 0, tokensCache: 0, tokensOutput: 0, cost: 0 },
      )

      const labelKey = grain === 'month' ? 'month' : 'year'
      return h(
        'div',
        { className: standalone ? 'llmu-detail llmu-period' : 'llmu-detail' },
        h(
          'div',
          { className: 'llmu-detail-head' },
          h('b', null, grain === 'month' ? t('detailMonthTitle') : t('detailYearTitle')),
          h('span', null, grain === 'month' ? t('detailMonthHint', { year }) : t('detailYearHint')),
        ),
        h(
          'div',
          { className: 'llmu-detail-scroll' },
          h(
            'table',
            { className: 'llmu-table llmu-detail-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, grain === 'month' ? t('detailMonth') : t('detailYear')),
                h('th', { scope: 'col' }, t('colCalls')),
                h('th', { scope: 'col', title: t('colInputHint') }, t('colInput')),
                h('th', { scope: 'col', title: t('colCacheHint') }, t('colCache')),
                h('th', { scope: 'col', title: t('colOutputHint') }, t('colOutput')),
                showCost ? h('th', { scope: 'col', title: t('colCostHint') }, t('colCost')) : null,
              ),
            ),
            h(
              'tbody',
              null,
              list.map((entry) =>
                h(
                  'tr',
                  { key: String(entry[labelKey]), 'data-empty': (entry.calls ?? 0) === 0 ? 'true' : 'false' },
                  h('td', null, String(entry[labelKey])),
                  h('td', null, formatInteger(entry.calls ?? 0)),
                  h('td', null, formatCompact(entry.tokens?.prompt ?? 0)),
                  h('td', null, formatCompact(entry.tokens?.cacheRead ?? 0)),
                  h('td', null, formatCompact(entry.tokens?.output ?? 0)),
                  showCost ? h('td', null, h(CostValue, { t, value: entry.cost ?? 0 })) : null,
                ),
              ),
            ),
            h(
              'tfoot',
              null,
              h(
                'tr',
                null,
                h('td', null, t('detailSum')),
                h('td', null, formatInteger(totals.calls)),
                h('td', null, formatCompact(totals.tokensPrompt)),
                h('td', null, formatCompact(totals.tokensCache)),
                h('td', null, formatCompact(totals.tokensOutput)),
                showCost ? h('td', null, h(CostValue, { t, value: totals.cost })) : null,
              ),
            ),
          ),
        ),
      )
    }

    function ModelTable({ t, platform, showCost, view }) {
      const [openModel, setOpenModel] = useState('')
      const columnCount = showCost ? 8 : 6
      const toggleModel = (modelId) => setOpenModel((current) => (current === modelId ? '' : modelId))

      return h(
        'div',
        { className: 'llmu-table-wrap' },
        h(
          'table',
          { className: 'llmu-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, t('colModel')),
              h('th', { scope: 'col' }, t('colCalls')),
              h('th', { scope: 'col' }, t('colOk')),
              h('th', { scope: 'col', title: t('colInputHint') }, t('colInput')),
              h('th', { scope: 'col', title: t('colCacheHint') }, t('colCache')),
              h('th', { scope: 'col', title: t('colOutputHint') }, t('colOutput')),
              showCost ? h('th', { scope: 'col', title: t('colCostHint') }, t('colCost')) : null,
              showCost ? h('th', { scope: 'col', title: t('colPriceHint') }, t('colPrice')) : null,
            ),
          ),
          h(
            'tbody',
            null,
            platform.models.flatMap((model) => {
              const expanded = openModel === model.model
              const row = h(
                'tr',
                {
                  key: model.model,
                  className: 'llmu-model-row',
                  'data-open': expanded ? 'true' : 'false',
                  tabIndex: 0,
                  title: expanded ? t('detailCollapse') : t('detailToggle'),
                  onClick: () => toggleModel(model.model),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleModel(model.model)
                    }
                  },
                },
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { className: 'llmu-model' },
                    h('span', { className: 'llmu-model-caret', 'data-open': expanded ? 'true' : 'false' }, '▸'),
                    h(
                      'div',
                      { className: 'llmu-model-text' },
                      h('b', { title: model.model }, model.model),
                      h(
                        'span',
                        null,
                        t('modelCalls', { calls: formatInteger(model.calls), last: formatTime(model.lastCall) }),
                      ),
                      model.failed || model.aborted
                        ? h(
                            'span',
                            null,
                            t('modelFailureNote', {
                              failed: formatInteger(model.failed ?? 0),
                              aborted: formatInteger(model.aborted ?? 0),
                            }),
                          )
                        : null,
                    ),
                  ),
                ),
                h('td', null, formatInteger(model.calls)),
                h(
                  'td',
                  {
                    title:
                      model.failed || model.aborted
                        ? t('failureDetail', { failed: model.failed, aborted: model.aborted })
                        : undefined,
                  },
                  percentText(model.calls, model.failed),
                  model.failed ? h('span', { className: 'llmu-suffix' }, `✗${model.failed}`) : null,
                ),
                h(
                  'td',
                  null,
                  formatCompact(model.tokens.prompt),
                  h('br'),
                  h('span', { className: 'llmu-suffix' }, t('uncachedNote', { tokens: formatCompact(model.tokens.input) })),
                ),
                h(
                  'td',
                  null,
                  formatCompact(model.tokens.cacheRead),
                  model.tokens.cacheWrite
                    ? h('span', { className: 'llmu-suffix' }, t('cacheWriteNote', { tokens: formatCompact(model.tokens.cacheWrite) }))
                    : null,
                ),
                h(
                  'td',
                  null,
                  formatCompact(model.tokens.output),
                  model.tokens.reasoning
                    ? h('span', { className: 'llmu-suffix' }, t('reasoningNote', { tokens: formatCompact(model.tokens.reasoning) }))
                    : null,
                ),
                showCost
                  ? h(
                      'td',
                      null,
                      model.costKnown ? h(CostValue, { t, value: model.cost }) : '—',
                      model.costKnown ? h('br') : null,
                      model.costKnown
                        ? h(
                            'span',
                            {
                              className: 'llmu-suffix',
                              title: priceWindowText(t, model.price),
                            },
                            hasTimeWindows(model.price) && model.cost > 0
                              ? t('costSplit', {
                                  peak: formatCost(model.peakCost ?? 0),
                                  off: formatCost(Math.max(0, model.cost - (model.peakCost ?? 0))),
                                })
                              : t('costHint'),
                          )
                        : null,
                    )
                  : null,
                showCost
                  ? h('td', { title: priceWindowText(t, model.price) }, priceSourceText(t, model))
                  : null,
              )

              if (!expanded) return [row]
              return [
                row,
                h(
                  'tr',
                  { key: `${model.model}::detail`, className: 'llmu-detail-row' },
                  h(
                    'td',
                    { colSpan: columnCount },
                    view.kind === 'day'
                      ? h(ModelDetail, {
                          t,
                          provider: platform.provider,
                          model: model.model,
                          days: view.days,
                          showCost,
                          utcOffsetHours: view.utcOffsetHours,
                        })
                      : h(PeriodDetail, {
                          t,
                          grain: view.kind,
                          year: view.year,
                          rows: view.kind === 'month' ? model.months : model.years,
                          showCost,
                        }),
                  ),
                ),
              ]
            }),
          ),
        ),
      )
    }

    function PlatformCard({ t, platform, open, onToggle, showCost, priceEntry, onPriceReport, view }) {
      return h(
        'section',
        { className: 'llmu-platform', 'data-open': open ? 'true' : 'false' },
        h(
          'div',
          { className: 'llmu-platform-head', onClick: onToggle },
          h(
            'button',
            {
              type: 'button',
              className: 'llmu-platform-toggle',
              'aria-expanded': open ? 'true' : 'false',
            },
          h(
            'svg',
            {
              viewBox: '0 0 16 16',
              className: 'llmu-caret',
              'data-open': open ? 'true' : 'false',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            },
            h('path', { d: 'M6 3l5 5-5 5' }),
          ),
          h(
            'span',
            { className: 'llmu-platform-name' },
            h('b', null, platform.displayName || platform.provider),
            h('span', null, t('modelCount', { provider: platform.provider, models: platform.models.length })),
          ),
        ),
        h(
          'span',
          { className: 'llmu-platform-stat' },
          h('div', null, h('em', null, t('colCalls')), h('b', null, formatInteger(platform.totals.calls))),
          h('div', null, h('em', null, t('statTokens')), h('b', null, formatCompact(platform.totals.tokens.total))),
          showCost
            ? h(
                'div',
                null,
                h('em', null, t('statCost')),
                h('b', null, h(CostValue, { t, value: platform.totals.cost, known: platform.costKnown })),
              )
            : null,
        ),
      ),
        h(SourceRow, {
          t,
          provider: platform.provider,
          entry: priceEntry,
          models: (platform.models ?? []).map((model) => model.model),
          onSaved: onPriceReport,
        }),
        open ? h(ModelTable, { t, platform, showCost, view }) : null,
      )
    }

    /* ---------------------------------- 主面板 ---------------------------------- */

    /** 本地日期键，与 Host 的分桶口径一致。 */
    function localDayKey(date = new Date()) {
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function dayLabel(day) {
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day
    }

    /** 把当前视图的明细汇总成「时间片 → 调用/token/花费」：按天 / 按月 / 按年。 */
    function trendSeries(summary) {
      const kind = summary.kind ?? 'day'
      const bucket = new Map()
      const push = (key, entry) => {
        const current = bucket.get(key) ?? { calls: 0, failed: 0, tokens: 0, cost: 0, peak: 0 }
        current.calls += entry.calls ?? 0
        current.failed += entry.failed ?? 0
        current.tokens += entry.tokens?.total ?? 0
        current.cost += entry.cost ?? 0
        current.peak += entry.peakCost ?? 0
        bucket.set(key, current)
      }
      if (kind === 'year') {
        // 「全部」视图直接吃月汇总聚合出来的年份行。
        for (const entry of summary.years ?? []) push(String(entry.year), entry)
      } else {
        const rowsOf = kind === 'month' ? 'months' : 'daily'
        const keyOf = kind === 'month' ? 'month' : 'day'
        for (const platform of summary.platforms) {
          for (const model of platform.models) {
            for (const entry of model[rowsOf] ?? []) push(entry[keyOf], entry)
          }
        }
      }
      return { kind, bucket }
    }

    function Trend({ t, summary, showCost }) {
      const { kind, bucket } = useMemo(() => trendSeries(summary), [summary])
      const [hover, setHover] = useState(-1)
      const series = useMemo(() => {
        if (kind === 'month') {
          const year = summary.year
          return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`)
        }
        if (kind === 'year') return [...bucket.keys()].sort()
        const ordered = [...bucket.keys()].sort()
        if (summary.days === 0 || summary.days >= 120) return ordered.slice(-60)
        const days = Math.max(1, summary.days)
        const today = new Date()
        const keys = []
        for (let offset = days - 1; offset >= 0; offset -= 1) {
          const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
          keys.push(localDayKey(date))
        }
        return keys
      }, [bucket, kind, summary.days, summary.year])

      const maxCalls = useMemo(
        () => series.reduce((peak, day) => Math.max(peak, bucket.get(day)?.calls ?? 0), 0),
        [series, bucket],
      )

      const weekdays = useMemo(() => String(t('weekdays') ?? '').split(','), [t])
      const title = kind === 'month' ? t('trendTitleMonth') : kind === 'year' ? t('trendTitleYear') : t('trendTitle')
      const hint = kind === 'month' ? t('trendHintMonth') : kind === 'year' ? t('trendHintYear') : t('trendHint')
      const axisLabel = (key) =>
        kind === 'day'
          ? dayLabel(key)
          : kind === 'month'
            ? t('monthAxis', { month: String(key).slice(5) })
            : String(key)

      if (series.length === 0) return null

      // 柱宽固定、图表宽度跟着天数走：天数少时不铺满整行，天数多时最多 680px。
      const trackWidth = Math.min(680, series.length * 30)

      const weekdayOf = (day) => {
        const parts = String(day).split('-').map((value) => Number(value))
        if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return ''
        return weekdays[new Date(parts[0], parts[1] - 1, parts[2]).getDay()] ?? ''
      }

      return h(
        'section',
        { className: 'llmu-trend' },
        h(
          'div',
          { className: 'llmu-trend-head' },
          h('b', null, title),
          h('span', null, hint),
        ),
        h(
          'div',
          { className: 'llmu-trend-body', style: { width: `${trackWidth}px` } },
          h(
            'div',
            { className: 'llmu-bars', role: 'img', 'aria-label': title },
            series.map((day, index) => {
              const entry = bucket.get(day)
              const calls = entry?.calls ?? 0
              const ratio = maxCalls > 0 ? Math.max(calls > 0 ? 0.08 : 0, calls / maxCalls) : 0
              const peak = entry?.peak ?? 0
              const cost = entry?.cost ?? 0
              const label = t('trendBar', {
                day,
                calls,
                tokens: formatCompact(entry?.tokens ?? 0),
                cost: showCost ? formatCost(cost) : '—',
              })
              const active = hover === index
              return h(
                'div',
                {
                  className: 'llmu-bar-slot',
                  key: day,
                  'aria-label': label,
                  onMouseEnter: () => setHover(index),
                  onMouseLeave: () => setHover((current) => (current === index ? -1 : current)),
                },
                active
                  ? h(
                      'div',
                      { className: 'llmu-tip', role: 'presentation' },
                      h(
                        'strong',
                        null,
                        kind === 'day' ? t('trendTipDay', { day, weekday: weekdayOf(day) }) : t('trendTipPeriod', { period: day }),
                      ),
                      h('div', null, t('trendTipCalls', { calls: formatInteger(calls) })),
                      h('div', null, t('trendTipTokens', { tokens: formatCompact(entry?.tokens ?? 0) })),
                      showCost
                        ? h('div', { className: 'llmu-tip-cost' }, t('trendTipCost', { cost: formatCost(cost) }))
                        : null,
                      showCost && peak > 0 && cost - peak > 0.0001
                        ? h(
                            'div',
                            null,
                            t('trendTipSplit', { peak: formatCost(peak), off: formatCost(Math.max(0, cost - peak)) }),
                          )
                        : null,
                      calls === 0 ? h('div', null, kind === 'day' ? t('trendTipEmpty') : t('trendTipEmptyPeriod')) : null,
                    )
                  : null,
                h('div', {
                  className: 'llmu-bar',
                  'data-empty': calls === 0 ? 'true' : 'false',
                  'data-active': active ? 'true' : 'false',
                  style: { height: `${Math.round(ratio * 100)}%` },
                }),
              )
            }),
          ),
          series.length > 1
            ? h(
                'div',
                { className: 'llmu-axis' },
                h('span', null, axisLabel(series[0])),
                series.length > 2
                  ? h(
                      'span',
                      null,
                      kind === 'day'
                        ? t('trendRange', { days: series.length, peak: maxCalls })
                        : t('trendRangePeriod', { periods: series.length, peak: maxCalls }),
                    )
                  : null,
                h('span', null, axisLabel(series[series.length - 1])),
              )
            : null,
        ),
      )
    }

    /** 官方账单对齐：手动抄官方日汇总，与插件当天记录逐项比较。 */
    function ReconciliationDialog({ t, initialDay, initialProvider, initialData, onClose }) {
      const [day, setDay] = useState(initialDay)
      const [provider, setProvider] = useState(initialProvider || '')
      const [data, setData] = useState(initialData ?? null)
      const [loading, setLoading] = useState(!initialData)
      const [error, setError] = useState('')
      const [officialCalls, setOfficialCalls] = useState('')
      const [officialCost, setOfficialCost] = useState('')
      const [officialTokens, setOfficialTokens] = useState('')
      const [reload, setReload] = useState(0)

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError('')
        fetchDayTotals(day)
          .then((payload) => {
            if (cancelled) return
            setData(payload)
            setProvider((current) => {
              if (payload.providers.some((entry) => entry.provider === current)) return current
              return payload.providers[0]?.provider ?? ''
            })
          })
          .catch((cause) => {
            if (!cancelled) {
              setData(null)
              setError(String(cause?.message ?? cause))
            }
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [day, reload])

      const asNumber = (value) => {
        if (String(value ?? '').trim() === '') return null
        const n = Number(value)
        return Number.isFinite(n) && n >= 0 ? n : null
      }
      const local = data?.providers?.find((entry) => entry.provider === provider) ?? null
      const officialCallsValue = asNumber(officialCalls)
      const officialCostValue = asNumber(officialCost)
      const officialTokensValue = asNumber(officialTokens)
      const deltaCalls = officialCallsValue != null && local ? officialCallsValue - local.calls : null
      const deltaCost = officialCostValue != null && local ? officialCostValue - local.cost : null
      const deltaTokens = officialTokensValue != null && local ? officialTokensValue - local.tokens.total : null
      const hasOfficial = officialCallsValue != null || officialCostValue != null || officialTokensValue != null
      const deltas = [deltaCalls, deltaCost, deltaTokens].filter((value) => value != null)
      const tone = !hasOfficial || !local
        ? ''
        : deltas.some((value) => value > 0.0000001)
          ? 'missing'
          : deltas.some((value) => value < -0.0000001)
            ? 'extra'
            : 'aligned'

      const changeProvider = (value) => {
        setProvider(value)
        setOfficialCalls('')
        setOfficialCost('')
        setOfficialTokens('')
      }
      const changeDay = (value) => {
        setDay(value)
        setOfficialCalls('')
        setOfficialCost('')
        setOfficialTokens('')
      }
      const toneKey =
        tone === 'missing' ? 'reconcileMissing' : tone === 'extra' ? 'reconcileExtra' : 'reconcileAligned'
      const signed = (value, formatter) => {
        if (value == null) return '—'
        if (Math.abs(value) < 0.0000001) return formatter(0)
        return `${value > 0 ? '+' : '-'}${formatter(Math.abs(value))}`
      }

      const rows = [
        {
          key: 'calls',
          label: t('reconcileCalls'),
          local: local ? formatInteger(local.calls) : '—',
          official: officialCallsValue != null ? formatInteger(officialCallsValue) : '—',
          delta: signed(deltaCalls, (value) => formatInteger(value)),
        },
        {
          key: 'cost',
          label: t('reconcileCost'),
          local: local ? formatExactCost(local.cost) : '—',
          official: officialCostValue != null ? formatExactCost(officialCostValue) : '—',
          delta: signed(deltaCost, (value) => formatExactCost(value)),
        },
        {
          key: 'tokens',
          label: t('reconcileTokens'),
          local: local ? formatInteger(local.tokens.total) : '—',
          official: officialTokensValue != null ? formatInteger(officialTokensValue) : '—',
          delta: signed(deltaTokens, (value) => formatInteger(value)),
        },
      ]

      return h(
        'div',
        {
          className: 'llmu-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('reconcileTitle'),
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'llmu-dialog llmu-dialog-wide' },
          h('h2', { className: 'llmu-dialog-title' }, t('reconcileTitle')),
          h('p', { className: 'llmu-reconcile-intro' }, t('reconcileIntro')),
          h(
            'div',
            { className: 'llmu-reconcile-fields' },
            h(
              'label',
              { className: 'llmu-field' },
              h('span', null, t('reconcileProvider')),
              h(
                'select',
                {
                  className: 'llmu-select',
                  value: provider,
                  disabled: loading || !data?.providers?.length,
                  onChange: (event) => changeProvider(event.target.value),
                },
                (data?.providers ?? []).map((entry) =>
                  h(
                    'option',
                    { key: entry.provider, value: entry.provider },
                    entry.displayName && entry.displayName !== entry.provider
                      ? `${entry.displayName} (${entry.provider})`
                      : entry.provider,
                  ),
                ),
              ),
            ),
            h(
              'label',
              { className: 'llmu-field' },
              h('span', null, t('reconcileDay')),
              h('input', {
                className: 'llmu-select',
                type: 'date',
                value: day,
                disabled: loading,
                onChange: (event) => changeDay(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'llmu-reconcile-official' },
            h(
              'label',
              { className: 'llmu-field' },
              h('span', null, t('reconcileOfficialCalls')),
              h('input', {
                className: 'llmu-select',
                type: 'number',
                min: 0,
                step: 1,
                inputMode: 'numeric',
                value: officialCalls,
                placeholder: t('reconcilePlaceholderCalls'),
                onChange: (event) => setOfficialCalls(event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'llmu-field' },
              h('span', null, t('reconcileOfficialCost')),
              h('input', {
                className: 'llmu-select',
                type: 'number',
                min: 0,
                step: 'any',
                inputMode: 'decimal',
                value: officialCost,
                placeholder: t('reconcilePlaceholderCost'),
                onChange: (event) => setOfficialCost(event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'llmu-field' },
              h('span', null, t('reconcileOfficialTokens')),
              h('input', {
                className: 'llmu-select',
                type: 'number',
                min: 0,
                step: 1,
                inputMode: 'numeric',
                value: officialTokens,
                placeholder: t('reconcilePlaceholderTokens'),
                onChange: (event) => setOfficialTokens(event.target.value),
              }),
            ),
          ),
          loading ? h('p', { className: 'llmu-reconcile-note' }, t('reconcileLoading')) : null,
          error ? h('p', { className: 'llmu-import-error' }, t('reconcileLoadFailed', { error })) : null,
          !loading && !error && data?.providers?.length === 0
            ? h('p', { className: 'llmu-reconcile-note' }, t('reconcileNoProviders'))
            : null,
          !loading && !error && data?.providers?.length > 0 && !local
            ? h('p', { className: 'llmu-reconcile-note' }, t('reconcileEmptyDay'))
            : null,
          local
            ? h(
                'table',
                { className: 'llmu-reconcile-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, ''),
                    h('th', null, t('reconcileLocal')),
                    h('th', null, t('reconcileOfficial')),
                    h('th', null, t('reconcileDelta')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row) =>
                    h(
                      'tr',
                      { key: row.key },
                      h('td', null, row.label),
                      h('td', null, row.local),
                      h('td', { className: row.official === '—' ? 'llmu-reconcile-muted' : null }, row.official),
                      h(
                        'td',
                        {
                          className:
                            row.delta === '—'
                              ? 'llmu-reconcile-delta llmu-reconcile-muted'
                              : 'llmu-reconcile-delta',
                          'data-tone': row.delta === '—' ? null : tone,
                        },
                        row.delta,
                      ),
                    ),
                  ),
                ),
              )
            : null,
          tone ? h('div', { className: 'llmu-reconcile-status' }, h('span', { className: 'llmu-reconcile-state', 'data-tone': tone }, t(toneKey))) : null,
          tone ? h('p', { className: 'llmu-reconcile-note' }, t('reconcileNote')) : null,
          h(
            'div',
            { className: 'llmu-dialog-actions' },
            h('button', { type: 'button', className: 'llmu-btn', onClick: onClose }, t('reconcileClose')),
            h(
              'button',
              {
                type: 'button',
                className: 'llmu-btn',
                disabled: loading,
                onClick: () => setReload((value) => value + 1),
              },
              t('reconcileRefresh'),
            ),
          ),
        ),
      )
    }

    function ExportDialog({ t, format, setFormat, range, setRange, detail, setDetail, year, busy, error, onCancel, onConfirm }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [busy, onCancel])

      return h(
        'div',
        {
          className: 'llmu-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('exportTitle'),
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        h(
          'div',
          { className: 'llmu-dialog' },
          h('h2', { className: 'llmu-dialog-title' }, t('exportTitle')),
          h(
            'label',
            { className: 'llmu-field' },
            h('span', null, t('exportFormat')),
            h(
              'select',
              {
                className: 'llmu-select',
                value: format,
                disabled: busy,
                onChange: (event) => setFormat(event.target.value),
              },
              h('option', { value: 'html' }, t('exportFormatHtml')),
              h('option', { value: 'pdf' }, t('exportFormatPdf')),
            ),
          ),
          format === 'pdf' ? h('p', { className: 'llmu-export-note' }, t('exportPdfHint')) : null,
          h(
            'label',
            { className: 'llmu-field' },
            h('span', null, t('exportRange')),
            h(
              'select',
              {
                className: 'llmu-select',
                value: range,
                disabled: busy,
                onChange: (event) => setRange(event.target.value),
              },
              h('option', { value: 'today' }, t('rangeToday')),
              h('option', { value: '7' }, t('range7')),
              h('option', { value: '30' }, t('range30')),
              h('option', { value: 'year' }, t('exportRangeYear', { year })),
              h('option', { value: 'all' }, t('rangeAll')),
            ),
          ),
          h(
            'label',
            { className: 'llmu-check' },
            h('input', {
              type: 'checkbox',
              checked: detail,
              disabled: busy,
              onChange: (event) => setDetail(event.target.checked),
            }),
            h(
              'span',
              null,
              h('strong', null, t('exportDetail')),
              h('em', null, t('exportDetailHint')),
            ),
          ),
          h('p', { className: 'llmu-export-warning' }, t('exportDataWarning')),
          error ? h('p', { className: 'llmu-import-error' }, t('exportFailed', { error })) : null,
          h(
            'div',
            { className: 'llmu-dialog-actions' },
            h('button', { type: 'button', className: 'llmu-btn', disabled: busy, onClick: onCancel }, t('exportCancel')),
            h('button', { type: 'button', className: 'llmu-btn llmu-btn-primary', disabled: busy, onClick: onConfirm }, busy ? t('exporting') : t('exportConfirm')),
          ),
        ),
      )
    }

    function UsagePanel({ t }) {
      const [range, setRange] = useState(7)
      const [live, setLive] = useState(true)
      const [summary, setSummary] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [syncing, setSyncing] = useState(false)
      const [priceNote, setPriceNote] = useState(null)
      const [tick, setTick] = useState(0)
      const [collapsed, setCollapsed] = useState(() => new Set())
      const [exportOpen, setExportOpen] = useState(false)
      const [reconcileOpen, setReconcileOpen] = useState(false)
      const [exportFormat, setExportFormat] = useState('html')
      const [exportRange, setExportRange] = useState('30')
      const [exportDetail, setExportDetail] = useState(true)
      const [exportBusy, setExportBusy] = useState(false)
      const [exportError, setExportError] = useState('')
      const loadSeq = useRef(0)

      const rangeLabels = useMemo(
        () => ({
          1: t('rangeToday'),
          7: t('range7'),
          30: t('range30'),
          0: t('rangeAll'),
        }),
        [t],
      )

      // 年份放在「近 30 天」和「全部」之间；只有月汇总里出现过的年份才显示。
      const rangeOptions = useMemo(() => {
        const years = (summary?.years ?? []).map((entry) => entry.year)
        return [1, 7, 30, ...years, 0]
      }, [summary])

      const rangeLabel = useCallback((value) => rangeLabels[value] ?? String(value), [rangeLabels])

      const load = useCallback(
        async (quiet) => {
          const seq = ++loadSeq.current
          try {
            const next = await fetchSummary(range)
            if (seq !== loadSeq.current) return
            setSummary(next)
            setError(null)
          } catch (cause) {
            if (seq === loadSeq.current && !quiet) setError(String(cause?.message ?? cause))
          } finally {
            if (seq === loadSeq.current) setLoading(false)
          }
        },
        [range],
      )

      useEffect(() => {
        let cancelled = false
        const seq = ++loadSeq.current
        setLoading(true)
        void (async () => {
          try {
            const next = await fetchSummary(range)
            if (!cancelled && seq === loadSeq.current) {
              setSummary(next)
              setError(null)
            }
          } catch (cause) {
            if (!cancelled && seq === loadSeq.current) setError(String(cause?.message ?? cause))
          } finally {
            if (!cancelled && seq === loadSeq.current) setLoading(false)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [range, tick])

      useEffect(() => {
        if (!live) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void load(true)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [live, load])

      useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState === 'visible') setTick((value) => value + 1)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [])

      const onTogglePlatform = useCallback((provider) => {
        setCollapsed((current) => {
          const next = new Set(current)
          if (next.has(provider)) next.delete(provider)
          else next.add(provider)
          return next
        })
      }, [])

      /** 保存某个平台的链接后：更新价格条并刷新数据（Host 已重算花费）。 */
      const onPriceReport = useCallback((report) => {
        detailCache.clear()
        setSummary((current) => (current && report ? { ...current, prices: report } : current))
        setTick((value) => value + 1)
      }, [])

      const onReset = useCallback(async () => {
        if (!window.confirm(t('confirmReset'))) return
        setBusy(true)
        try {
          await resetUsage()
          detailCache.clear()
          setCollapsed(new Set())
          setTick((value) => value + 1)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [t])

      /** 刷新 models.dev 目录；成功后 Host 会按新价格重算历史花费。 */
      const onSyncPrices = useCallback(async () => {
        if (syncing) return
        setSyncing(true)
        setPriceNote(null)
        try {
          const report = await syncPriceTable()
          const models = (report?.providers ?? []).reduce((sum, entry) => sum + (Number(entry.models) || 0), 0)
          const failed = (report?.errors ?? []).map((entry) => entry.title || entry.provider)
          setPriceNote({
            tone: failed.length > 0 ? 'warn' : 'ok',
            text:
              (failed.length > 0
                ? t('priceSyncPartial', { providers: failed.join(t('listSeparator')) }) + ' · '
                : '') + t('priceSynced', { models }),
          })
          onPriceReport(report)
        } catch (cause) {
          setPriceNote({ tone: 'warn', text: t('priceSyncNone', { error: String(cause?.message ?? cause) }) })
        } finally {
          setSyncing(false)
        }
      }, [onPriceReport, syncing, t])

      if (loading && !summary) {
        return h('div', { className: 'llmu-root' }, h(StyleTag), h('div', { className: 'llmu-empty' }, t('loading')))
      }

      if (!summary) {
        return h(
          'div',
          { className: 'llmu-root' },
          h(StyleTag),
          h(
            'div',
            { className: 'llmu-empty llmu-error' },
            t('failed'),
            error ? h('div', null, error) : null,
          ),
          h(
            'div',
            { className: 'llmu-toolbar' },
            h('button', { type: 'button', className: 'llmu-btn', onClick: () => setTick((v) => v + 1) }, t('retry')),
          ),
        )
      }

      const showCost = summary.showCost !== false
      const totals = summary.totals
      const successRate = totals.calls ? ((totals.calls - totals.failed) / totals.calls) * 100 : 0
      const hasData = summary.platforms.length > 0
      const view = { kind: summary.kind ?? 'day', days: summary.days, year: summary.year, utcOffsetHours: summary.utcOffsetHours }
      const exportYear = Number(view.year) || new Date().getFullYear()
      const reconciliationDay = (() => {
        const offset = Number(summary.utcOffsetHours)
        const shifted = new Date(Date.now() + (Number.isFinite(offset) ? offset : 8) * 3600 * 1000)
        return shifted.toISOString().slice(0, 10)
      })()
      const openExport = () => {
        setExportFormat('html')
        setExportDetail(true)
        setExportError('')
        setExportRange(
          view.kind === 'month'
            ? 'year'
            : view.kind === 'year'
              ? view.year
                ? 'year'
                : 'all'
              : view.days === 1
                ? 'today'
                : view.days >= 30
                  ? '30'
                  : '7',
        )
        setExportOpen(true)
      }
      const confirmExport = async () => {
        if (exportBusy) return
        const query = `${exportRangeQuery(exportRange, exportYear)}&detail=${exportDetail ? '1' : '0'}`
        const format = exportFormat === 'pdf' ? 'pdf' : 'html'
        setExportBusy(true)
        setExportError('')
        try {
          await downloadExport(`${API_BASE}/export.${format}?${query}`, exportFileName(exportRange, format, exportYear))
          setExportOpen(false)
        } catch (cause) {
          setExportError(String(cause?.message ?? cause))
        } finally {
          setExportBusy(false)
        }
      }
      const unpriced = Array.isArray(summary.unpricedModels) ? summary.unpricedModels : []
      const priceByProvider = new Map((summary.prices?.providers ?? []).map((entry) => [entry.provider, entry]))

      return h(
        'div',
        { className: 'llmu-root' },
        h(StyleTag),
        h(
          'div',
          { className: 'llmu-head' },
          h(
            'div',
            { className: 'llmu-head-main' },
            h('h1', { className: 'llmu-title' }, t('title')),
            h(
              'p',
              { className: 'llmu-sub' },
              t('subtitle', {
                platforms: totals.platforms,
                models: totals.models,
                updated: formatTime(summary.generatedAt),
              }),
              h('span', { className: 'llmu-scope' }, t('scopeNote')),
              h('span', { className: 'llmu-scope llmu-scope-em' }, t('scopeOnly')),
            ),
          ),
          h(
            'div',
            { className: 'llmu-toolbar' },
            h(
              'div',
              { className: 'llmu-seg', role: 'group', 'aria-label': t('rangeLabel') },
              rangeOptions.map((value) =>
                h(
                  'button',
                  {
                    key: String(value),
                    type: 'button',
                    'data-active': String(value) === String(range) ? 'true' : 'false',
                    onClick: () => setRange(value),
                  },
                  rangeLabel(value),
                ),
              ),
            ),
            h(
              'span',
              { className: 'llmu-live', title: t('liveHint') },
              h('span', { className: 'llmu-dot', 'data-on': live ? 'true' : 'false' }),
              h(
                'label',
                null,
                h('input', {
                  type: 'checkbox',
                  checked: live,
                  onChange: (event) => setLive(event.target.checked),
                  className: 'llmu-sr',
                }),
                t('live'),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'llmu-btn',
                onClick: () => setTick((value) => value + 1),
                disabled: loading,
              },
              loading ? t('refreshing') : t('refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'llmu-btn',
                onClick: onSyncPrices,
                disabled: syncing,
                title: t('priceAutoNote'),
              },
              syncing ? t('priceSyncing') : t('priceSync'),
            ),
            h(
              'button',
              { type: 'button', className: 'llmu-btn', 'data-tone': 'danger', onClick: onReset, disabled: busy },
              t('reset'),
            ),
          ),
        ),
        showCost
          ? h(PriceBanner, {
              t,
              prices: summary.prices,
              note: priceNote,
            })
          : null,
        h(
          'div',
          { className: 'llmu-cards' },
          h(Card, {
            label: t('cardCalls'),
            value: formatInteger(totals.calls),
            hint: t('cardCallsHint', { platforms: totals.platforms, models: totals.models }),
          }),
          h(Card, {
            label: t('cardTokens'),
            value: formatCompact(totals.tokens.total),
            hint: t('cardTokensHint', {
              prompt: formatCompact(totals.tokens.prompt),
              output: formatCompact(totals.tokens.output),
            }),
          }),
          showCost
            ? h(Card, {
                label: t('cardCost'),
                value: h(CostValue, { t, value: totals.cost }),
                hint:
                  totals.peakCost > 0 && totals.cost - totals.peakCost > 0
                    ? t('costSplit', {
                        peak: formatCost(totals.peakCost),
                        off: formatCost(Math.max(0, totals.cost - totals.peakCost)),
                      })
                    : t('cardCostHint'),
              })
            : null,
          h(Card, {
            label: t('cardOk'),
            value: totals.calls ? `${successRate.toFixed(successRate >= 99.95 ? 0 : 1)}%` : '—',
            hint: t('cardOkHint', { failed: totals.failed, aborted: totals.aborted }),
          }),
        ),
        hasData && view.kind === 'month'
          ? h(PeriodDetail, { t, grain: 'month', year: view.year, rows: summary.months ?? [], showCost, standalone: true })
          : hasData && view.kind === 'year'
            ? h(PeriodDetail, { t, grain: 'year', rows: summary.years ?? [], showCost, standalone: true })
            : null,
        error ? h(Notice, { tone: 'warn' }, h('span', null, t('stale', { error }))) : null,
        showCost && unpriced.length > 0
          ? h(
              Notice,
              { tone: 'warn' },
              h(
                'span',
                null,
                h('strong', null, t('unpricedTitle')),
                ' ',
                t('unpricedBody', {
                  models: unpriced.slice(0, 3).join(t('listSeparator')) +
                    (unpriced.length > 3 ? t('listMore', { count: unpriced.length }) : ''),
                }),
              ),
            )
          : null,
        hasData ? h(Trend, { t, summary, showCost }) : null,
        !hasData
          ? h('div', { className: 'llmu-empty' }, h('div', null, t('empty')), h('div', null, t('emptyHint')))
          : h(
              'div',
              { className: 'llmu-platforms' },
              summary.platforms.map((platform) =>
                h(PlatformCard, {
                  key: platform.provider,
                  t,
                  platform,
                  showCost,
                  view,
                  open: !collapsed.has(platform.provider),
                  onToggle: () => onTogglePlatform(platform.provider),
                  priceEntry: priceByProvider.get(platform.provider),
                  onPriceReport,
                }),
              ),
            ),
        h('div', { className: 'llmu-source-note' }, t('sourceNote')),
        h(
          'div',
          { className: 'llmu-foot' },
          h('span', null, t('footerRetention', { days: summary.retainDays })),
          h(
            'button',
            {
              type: 'button',
              className: 'llmu-export',
              onClick: openExport,
              title: t('exportHint'),
            },
            t('exportReport'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'llmu-export',
              onClick: () => setReconcileOpen(true),
              title: t('reconcileHint'),
            },
            t('reconcileOpen'),
          ),
          showCost ? h('span', null, t('footerPrice', { file: 'cordis.patch.yml' })) : null,
          h('span', null, t('footerFile', { file: 'llm-usage-insights/usage.json' })),
        ),
        exportOpen
          ? h(ExportDialog, {
              t,
              format: exportFormat,
              setFormat: setExportFormat,
              range: exportRange,
              setRange: setExportRange,
              detail: exportDetail,
              setDetail: setExportDetail,
              year: exportYear,
              busy: exportBusy,
              error: exportError,
              onCancel: () => setExportOpen(false),
              onConfirm: confirmExport,
            })
          : null,
        reconcileOpen
          ? h(ReconciliationDialog, {
              t,
              initialDay: reconciliationDay,
              initialProvider:
                (summary.platforms.find((entry) => /^deepseek/i.test(entry.provider)) ?? summary.platforms[0])?.provider ??
                '',
              onClose: () => setReconcileOpen(false),
            })
          : null,
      )
    }

    function PanelHost({ locale }) {
      const snapshot = useLocaleSnapshot(locale)
      activeNumberLocale = localeTagOf(snapshot)
      const t = useMemo(() => translate(locale, snapshot), [locale, snapshot])
      return h(UsagePanel, { t })
    }

    /** 供侧栏 label 使用：语言切换后，宿主每次投影都会重新读这个函数。 */
    function navLabel(locale) {
      return translate(locale, locale.getSnapshot())('nav')
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 逐语言注册（untyped 形式），不依赖内置语言集合的数量。
        ctx.effect(() => {
          const disposers = []
          for (const [locale, dict] of Object.entries(dictionaries)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch (error) {
              // 语言接口变化时只损失本地化，不应该连带让侧栏和页面注册失败。
              console.error(`llm-usage: 注册语言 ${locale} 失败：${String(error?.message ?? error)}`)
            }
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                // 重复释放无害。
              }
            }
          }
        })

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: SIDEBAR_ID,
              order: 20,
              label: () => navLabel(ctx.locale),
            },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_KEY },
            (ownerProps = {}) => h(PanelHost, { locale: ctx.locale, ...ownerProps }),
          ),
        )
      },
    }
  },
  })
}
