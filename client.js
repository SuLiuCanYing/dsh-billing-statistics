window.__ModuleLoader__.load({
  id: 'llm-usage-insights',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo
    const useSyncExternalStore = React.useSyncExternalStore

    const NS = 'llm-usage'
    const SIDEBAR_ID = 'llm-usage'
    const PANEL_KEY = 'llm-usage'
    const API_BASE = '/api/llm-usage/v1'
    const POLL_MS = 5000
    const RANGES = [1, 7, 30, 0]

    /* -------------------------------- 本地化文案 -------------------------------- */

    const dictionaries = {
      zh: {
        nav: '用量统计',
        title: '模型用量与花费',
        subtitle: '{platforms} 个平台 · {models} 个模型 · 更新于 {updated}',
        scopeNote: '计量单位是每一次模型请求尝试，含重试与标题生成、压缩等辅助调用。',
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
        cardCostHint: '按官网/配置价格折算，不是账单',
        cardOk: '成功率',
        cardOkHint: '失败 {failed} · 中断 {aborted}',
        unpricedTitle: '部分模型没有价格：',
        unpricedBody: '{models}。这些模型只统计 token，不计花费；可在插件配置 pricing 中补上价格。',
        listSeparator: '、',
        listMore: ' 等 {count} 个',
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
        colPrice: '价格来源',
        colPriceHint: '「官网同步」来自平台官网价格页；「已配置」来自插件 pricing；「内置估算」是抓不到官网时的兜底',
        priceCustom: '已配置',
        priceOfficial: '官网同步',
        priceEstimate: '内置估算',
        priceMissing: '未配置',
        priceBanner: '官网价格：{providers}（每天自动同步一次，最近 {time}）',
        priceBannerNever: '还没抓过官网价格，点上方「刷新官网价格」；没填链接的平台会自动搜索。',
        priceSync: '刷新官网价格',
        priceSyncing: '抓取中…',
        priceSynced: '更新了 {models} 个模型的价格',
        priceSyncPartial: '部分平台失败：{providers}',
        priceSyncNone: '抓取失败：{error}',
        priceStale: '今天还没同步',
        priceAutoNote: '每天自动同步一次；当天没开程序的话，下次启动会补抓。',
        sourcePlaceholder: '选填：平台官网链接',
        sourceSave: '保存',
        sourceSaving: '保存中…',
        sourceSaved: '已保存，正在重新抓取价格',
        sourceCleared: '已清空，恢复自动搜索',
        sourceInvalid: '链接需以 http:// 或 https:// 开头',
        sourceAutoTag: '自动填入',
        sourceManualTag: '手动填写',
        sourceBuiltinTag: '已知官网',
        sourceEmptyTag: '未填',
        sourceStatusOk: '已解析 {models} 个模型的价格',
        sourceStatusNone: '还没填链接，暂时按内置规则计费',
        sourceStatusFail: '没解析到价格，改用内置规则：{error}',
        sourceFailTitle: '自动搜索没成功，暂时按内置规则计费',
        sourceFailHintKey: '原因是内置的官方搜索插件要调用 DeepSeek 官方 API（api.deepseek.com）做联网搜索，所以必须有 DeepSeek 官方账号的 API 密钥（DEEPSEEK_API_KEY，在网页端模型设置里填）；用硅基流动等其它平台的密钥替代不了。也可以直接在上面填写这个平台的官网链接，没明确价格时仍按内置规则计费。',
        sourceFailHint: '可以上面填写这个平台的官网链接；配置 DeepSeek 官方 API 密钥（DEEPSEEK_API_KEY）后自动搜索也能用，没明确价格时按内置规则计费。',
        sourceNote: '未填平台链接会自动搜索填入；自动填入或抓到的价格不对，可以直接改这里的链接；没有明确结果时按内置规则计费。',
        peakLabel: '峰时',
        offPeakLabel: '谷时',
        costSplit: '峰 {peak} · 谷 {off}',
        tierNote: '阶梯价（按输入长度分档）',
        windowAllDay: '全天',
        priceTipTitle: '官网单价（元 / 百万 token）',
        costHint: '估算',
        modelCalls: '{calls} 次 · 最近 {last}',
        modelCount: '{provider} · {models} 个模型',
        colCache: '缓存 Token',
        colCacheHint: '缓存命中（读取）token；有缓存写入时在下方标注',
        uncachedNote: '未命中 {tokens}',
        cacheWriteNote: '写入 {tokens}',
        reasoningNote: '含思考 {tokens}',
        failureDetail: '失败 {failed} · 中断 {aborted}',
        rateTitle: '¥/百万 token：输入 {input} · 输出 {output} · 缓存 {cacheRead}',
        trendTitle: '每日调用',
        trendHint: '柱高为当天调用次数；鼠标移到柱子上看日期与花费',
        trendRange: '{days} 天 · 峰值 {peak} 次',
        trendBar: '{day}：{calls} 次调用 · {tokens} token · {cost}',
        trendTipDay: '{day} {weekday}',
        trendTipCalls: '{calls} 次调用',
        trendTipTokens: '{tokens} token',
        trendTipCost: '花费 {cost}',
        trendTipSplit: '峰 {peak} · 谷 {off}',
        trendTipEmpty: '这天没有调用',
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
        empty: '还没有记录到模型调用。',
        emptyHint: '在这个 Harness 里发起一次对话（或让子代理、标题生成等调用模型），数据会出现在这里。',
        footerRetention: '按天明细保留 {days} 天。',
        footerPrice: '价格在「设置 → 插件 → llm-usage-insights」的配置 pricing 里改；也可写进 profile 的 {file}。',
        footerFile: '数据文件：$DSH_HOME/{file}',
      },
      en: {
        nav: 'Usage',
        title: 'Model usage & spend',
        subtitle: '{platforms} platforms · {models} models · updated {updated}',
        scopeNote: 'Counts are model request attempts, including retries and auxiliary calls such as titles and compaction.',
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
        cardCostHint: 'computed from official/configured prices, not an invoice',
        cardOk: 'Success',
        cardOkHint: '{failed} failed · {aborted} aborted',
        unpricedTitle: 'Some models have no price:',
        unpricedBody: '{models}. Their tokens are counted but not priced; add rates under the plugin config "pricing".',
        listSeparator: ', ',
        listMore: ' and {count} more',
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
        colPrice: 'Price',
        colPriceHint: '"official sync" comes from the provider pricing page; "configured" from the plugin pricing; "built-in estimate" is the fallback',
        priceCustom: 'configured',
        priceOfficial: 'official sync',
        priceEstimate: 'built-in estimate',
        priceMissing: 'not set',
        priceBanner: 'Official prices: {providers} (auto-synced daily, last {time})',
        priceBannerNever: 'No official prices yet. Click "Refresh official prices"; platforms without a link are searched automatically.',
        priceSync: 'Refresh official prices',
        priceSyncing: 'Fetching…',
        priceSynced: 'Updated prices for {models} models',
        priceSyncPartial: 'Some platforms failed: {providers}',
        priceSyncNone: 'Sync failed: {error}',
        priceStale: 'not synced today',
        priceAutoNote: 'Auto-syncs once a day; a missed day is caught up on the next launch.',
        sourcePlaceholder: 'Optional: platform pricing page URL',
        sourceSave: 'Save',
        sourceSaving: 'Saving…',
        sourceSaved: 'Saved, fetching prices again',
        sourceCleared: 'Cleared, back to auto-search',
        sourceInvalid: 'URL must start with http:// or https://',
        sourceAutoTag: 'auto-filled',
        sourceManualTag: 'manual',
        sourceBuiltinTag: 'known page',
        sourceEmptyTag: 'not set',
        sourceStatusOk: 'parsed prices for {models} models',
        sourceStatusNone: 'no link yet, using built-in rules',
        sourceStatusFail: 'no prices parsed, using built-in rules: {error}',
        sourceFailTitle: 'Auto search failed — built-in rules are pricing it for now',
        sourceFailHintKey: 'The built-in official search plugin calls DeepSeek\'s official API (api.deepseek.com) to run web search, so it needs an API key from a DeepSeek official account (DEEPSEEK_API_KEY — set it on the web Models page); a key from SiliconFlow or any other provider cannot substitute. You can also paste this platform\'s pricing URL above — built-in rules still price it when nothing clear is found.',
        sourceFailHint: 'Paste the platform\'s pricing URL above; configuring a DeepSeek official API key (DEEPSEEK_API_KEY) also enables auto search. Built-in rules price it when nothing clear is found.',
        sourceNote: 'Empty links are auto-filled by search; edit the link if the auto-filled page or its prices are wrong; when nothing clear is found, built-in rules price it.',
        peakLabel: 'peak',
        offPeakLabel: 'off-peak',
        costSplit: 'peak {peak} · off {off}',
        tierNote: 'tiered by input length',
        windowAllDay: 'all day',
        priceTipTitle: 'Official rates (CNY per 1M tokens)',
        costHint: 'estimate',
        modelCalls: '{calls} calls · last {last}',
        modelCount: '{provider} · {models} models',
        colCache: 'Cache tokens',
        colCacheHint: 'Cache read tokens; cache write tokens are noted below',
        uncachedNote: 'uncached {tokens}',
        cacheWriteNote: 'write {tokens}',
        reasoningNote: 'incl. {tokens} thinking',
        failureDetail: '{failed} failed · {aborted} aborted',
        rateTitle: 'CNY per 1M tokens: input {input} · output {output} · cache {cacheRead}',
        trendTitle: 'Calls per day',
        trendHint: 'Bar height is the call count; hover a bar for the date and spend',
        trendRange: '{days} days · peak {peak} calls',
        trendBar: '{day}: {calls} calls · {tokens} tokens · {cost}',
        trendTipDay: '{day} {weekday}',
        trendTipCalls: '{calls} calls',
        trendTipTokens: '{tokens} tokens',
        trendTipCost: 'spend {cost}',
        trendTipSplit: 'peak {peak} · off {off}',
        trendTipEmpty: 'no calls on this day',
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
        empty: 'No model calls recorded yet.',
        emptyHint: 'Send a message in this Harness (or let a subagent or title generator call a model) and the numbers appear here.',
        footerRetention: 'Daily buckets are kept for {days} days.',
        footerPrice: 'Edit rates under Settings → Plugins → llm-usage-insights (config "pricing"), or in the profile {file}.',
        footerFile: 'Data file: $DSH_HOME/{file}',
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
.llmu-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.llmu-seg {
  display: inline-flex; align-items: center; padding: 2px; gap: 2px;
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
.llmu-badge { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 999px; font-style: normal; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.llmu-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.llmu-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.llmu-source-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 12px 10px; }
.llmu-source-wrap { display: flex; flex-direction: column; }
.llmu-source-fail {
  margin: -4px 12px 10px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1);
  font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-error-primary);
}
.llmu-source-fail-title { font-weight: 600; }
.llmu-source-tag { flex: none; padding: 1px 6px; border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.llmu-source-tag[data-origin='auto'] { color: var(--dsw-alias-state-warn-primary); }
.llmu-source-input { flex: 1 1 260px; min-width: 0; height: 26px; padding: 0 8px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.llmu-source-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.llmu-source-status { font-size: 11px; color: var(--dsw-alias-label-secondary); }
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
.llmu-note {
  display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.llmu-note[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary); }
.llmu-note strong { font-weight: 600; }
.llmu-platform {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  overflow: hidden; flex: none;
}
.llmu-platform-head {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 12px 14px; border: 0; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.llmu-platform-head:hover { background: var(--dsw-alias-bg-layer-2); }
.llmu-caret { width: 14px; flex: none; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.llmu-caret[data-open='true'] { transform: rotate(90deg); }
.llmu-platform-name { flex: 1 1 auto; min-width: 0; }
.llmu-platform-name b { display: block; font-size: 14px; font-weight: 600; }
.llmu-platform-name span { display: block; margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llmu-platform-stat { display: flex; gap: 18px; flex: none; font-size: 12px; }
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
          return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2).replace(/\\.0+$/, '')}${unit.suffix}`
        }
      }
      return String(Math.round(n))
    }

    function formatCost(value) {
      const n = Number(value) || 0
      if (n === 0) return '¥0'
      if (n >= 100) return `¥${n.toFixed(1)}`
      if (n >= 1) return `¥${n.toFixed(2)}`
      if (n >= 0.01) return `¥${n.toFixed(3)}`
      return `¥${n.toFixed(4)}`
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

    async function fetchSummary(days) {
      // 0（全部）用一个足够大的窗口表达，旧版 Host 也能给出全部保留数据。
      const query = days === 0 ? 3660 : days
      const response = await fetch(`${API_BASE}/summary?days=${query}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad-payload')
      return payload
    }

    /** 某平台某模型的按小时明细；同一个 key 缓存 60 秒，避免反复展开时重复请求。 */
    const detailCache = new Map()

    async function fetchModelDetail(provider, model, days) {
      const windowDays = Number.isFinite(Number(days)) ? Number(days) : 0
      const key = `${provider}|${model}|${windowDays}`
      const cached = detailCache.get(key)
      if (cached && Date.now() - cached.at < 60_000) return cached.data
      const query = new URLSearchParams({ provider, model, days: String(windowDays === 0 ? 3660 : windowDays) })
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

    /** 触发 Host 抓取官网价格页；返回同步报告。 */
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

    /** 保存某个平台的官网链接（空字符串 = 清空，回到自动搜索），并立即重抓该平台。 */
    async function saveSourceUrl(provider, url) {
      const response = await fetch(`${API_BASE}/sources`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ provider, url }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
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
     * 价格条：显示已抓到官网价格的平台、同步时间与失败原因。
     * 「刷新官网价格」按钮在工具栏里（Host 每天自动同步一次）。
     */
    function PriceBanner({ t, prices, note }) {
      if (!prices) return null
      const entries = Array.isArray(prices.providers) ? prices.providers : []
      const synced = entries.filter((entry) => entry.ok)
      const errors = Array.isArray(prices.errors) ? prices.errors : []
      const names = synced.map((entry) => entry.title || entry.provider).join(t('listSeparator'))
      const message =
        synced.length > 0
          ? t('priceBanner', { providers: names, time: formatTime(prices.fetchedAt) })
          : t('priceBannerNever')
      return h(
        'div',
        { className: 'llmu-price-bar' },
        h(
          'span',
          { className: 'llmu-price-text' },
          message,
          prices.stale && synced.length > 0 ? h('em', { className: 'llmu-badge', 'data-tone': 'warn' }, t('priceStale')) : null,
          h('em', { className: 'llmu-badge' }, t('priceAutoNote')),
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
      )
    }

    /**
     * 平台官网链接行：可编辑、可清空；保存后 Host 只重抓这个平台。
     * 没填链接时 Host 会自动搜索填入，这里会显示「自动填入」标记提示用户核对。
     */
    function SourceRow({ t, provider, entry, onSaved }) {
      const [url, setUrl] = useState(entry?.url ?? '')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)

      useEffect(() => {
        setUrl(entry?.url ?? '')
        setNote(null)
      }, [entry?.url])

      const originTag =
        entry?.origin === 'auto'
          ? t('sourceAutoTag')
          : entry?.origin === 'manual'
            ? t('sourceManualTag')
            : entry?.origin === 'builtin' || entry?.origin === 'config'
              ? t('sourceBuiltinTag')
              : t('sourceEmptyTag')

      const status = entry?.ok
        ? t('sourceStatusOk', { models: entry.models })
        : entry?.missing
          ? t('sourceStatusNone')
          : entry?.error
            ? t('sourceStatusFail', { error: entry.error })
            : ''

      const save = async () => {
        const value = url.trim()
        if (value && !/^https?:\/\//i.test(value)) {
          setNote({ tone: 'warn', text: t('sourceInvalid') })
          return
        }
        setBusy(true)
        setNote(null)
        try {
          const report = await saveSourceUrl(provider, value)
          if (report) onSaved?.(report)
          setNote({ tone: 'ok', text: value ? t('sourceSaved') : t('sourceCleared') })
        } catch (cause) {
          setNote({ tone: 'warn', text: String(cause?.message ?? cause) })
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
          h('span', { className: 'llmu-source-tag', 'data-origin': entry?.origin ?? '' }, originTag),
          h('input', {
            type: 'text',
            className: 'llmu-source-input',
            value: url,
            placeholder: t('sourcePlaceholder'),
            spellCheck: false,
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'llmu-btn', onClick: () => void save(), disabled: busy },
            busy ? t('sourceSaving') : t('sourceSave'),
          ),
          status ? h('span', { className: 'llmu-source-status', 'data-ok': entry?.ok ? 'true' : 'false' }, status) : null,
          note ? h('em', { className: 'llmu-badge', 'data-tone': note.tone }, note.text) : null,
        ),
        entry?.searchFailed
          ? h(
              'div',
              { className: 'llmu-source-fail' },
              h(
                'div',
                { className: 'llmu-source-fail-title', title: entry.searchReason || undefined },
                t('sourceFailTitle'),
              ),
              h('div', null, entry.searchCode === 'credential' ? t('sourceFailHintKey') : t('sourceFailHint')),
            )
          : null,
      )
    }

    function priceSourceText(t, model) {
      const source = model?.price?.source
      if (source === 'custom') return t('priceCustom')
      if (source === 'official') return t('priceOfficial')
      if (source === 'estimate') return t('priceEstimate')
      return t('priceMissing')
    }

    function rateText(rate) {
      const value = rate ?? {}
      return `输入 ${value.input ?? 0} / 输出 ${value.output ?? 0} / 缓存 ${value.cacheRead ?? 0}`
    }

    /** 价格明细（悬停提示）：时段 / 阶梯 + 单价。 */
    function priceWindowText(t, price) {
      const lines = [t('priceTipTitle')]
      for (const period of price?.periods ?? []) {
        const ranges = (period.ranges ?? []).map(([from, to]) => `${from}–${to}点`).join('、') || t('windowAllDay')
        const days = Array.isArray(period.days) ? '周一至周五 · ' : ''
        lines.push(`${days}${period.label ? `${period.label} · ` : ''}${ranges}：${rateText(period.rate)}`)
      }
      if (price?.defaultRate) lines.push(`${t('offPeakLabel')}（其余时段）：${rateText(price.defaultRate)}`)
      for (const tier of price?.tiers ?? []) lines.push(`${tier.label || t('tierNote')}：${rateText(tier.rate)}`)
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

    /** 北京时间「今天」（YYYY-MM-DD），用于默认定位到当前日期。 */
    function beijingToday() {
      return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    }

    /** 模型行二次展开后的按小时明细，点开时才去 Host 取数。 */
    function ModelDetail({ t, provider, model, days, showCost }) {
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
      const today = beijingToday()
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
          sum.cost += entry.cost ?? 0
          return sum
        },
        { calls: 0, tokens: 0, cost: 0 },
      )

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
                        formatCost(entry.cost ?? 0),
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
            totals
              ? h(
                  'tfoot',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', null, t('detailSum')),
                    h('td', null, ''),
                    h('td', null, formatInteger(totals.calls ?? 0)),
                    h('td', null, formatCompact(totals.tokens?.prompt ?? 0)),
                    h('td', null, formatCompact(totals.tokens?.cacheRead ?? 0)),
                    h('td', null, formatCompact(totals.tokens?.output ?? 0)),
                    showCost ? h('td', null, formatCost(totals.cost ?? 0)) : null,
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

    function ModelTable({ t, platform, showCost, range }) {
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
                      model.costKnown ? formatCost(model.cost) : '—',
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
                    h(ModelDetail, {
                      t,
                      provider: platform.provider,
                      model: model.model,
                      days: range,
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

    function PlatformCard({ t, platform, open, onToggle, showCost, priceEntry, onPriceReport, range }) {
      return h(
        'section',
        { className: 'llmu-platform' },
        h(
          'button',
          {
            type: 'button',
            className: 'llmu-platform-head',
            onClick: onToggle,
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
                  h('b', null, platform.costKnown ? formatCost(platform.totals.cost) : '—'),
                )
              : null,
          ),
        ),
        h(SourceRow, { t, provider: platform.provider, entry: priceEntry, onSaved: onPriceReport }),
        open ? h(ModelTable, { t, platform, showCost, range }) : null,
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

    /** 把每个模型的 daily 汇总成「日期 → 调用/token/花费」。 */
    function dailySeries(summary) {
      const bucket = new Map()
      for (const platform of summary.platforms) {
        for (const model of platform.models) {
          for (const entry of model.daily ?? []) {
            const current = bucket.get(entry.day) ?? { calls: 0, failed: 0, tokens: 0, cost: 0, peak: 0 }
            current.calls += entry.calls ?? 0
            current.failed += entry.failed ?? 0
            current.tokens += entry.tokens?.total ?? 0
            current.cost += entry.cost ?? 0
            current.peak += entry.peakCost ?? 0
            bucket.set(entry.day, current)
          }
        }
      }
      return bucket
    }

    function Trend({ t, summary, showCost }) {
      const bucket = useMemo(() => dailySeries(summary), [summary])
      const [hover, setHover] = useState(-1)
      const series = useMemo(() => {
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
      }, [bucket, summary.days])

      const maxCalls = useMemo(
        () => series.reduce((peak, day) => Math.max(peak, bucket.get(day)?.calls ?? 0), 0),
        [series, bucket],
      )

      const weekdays = useMemo(() => String(t('weekdays') ?? '').split(','), [t])

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
          h('b', null, t('trendTitle')),
          h('span', null, t('trendHint')),
        ),
        h(
          'div',
          { className: 'llmu-trend-body', style: { width: `${trackWidth}px` } },
          h(
            'div',
            { className: 'llmu-bars', role: 'img', 'aria-label': t('trendTitle') },
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
                      h('strong', null, t('trendTipDay', { day, weekday: weekdayOf(day) })),
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
                      calls === 0 ? h('div', null, t('trendTipEmpty')) : null,
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
                h('span', null, dayLabel(series[0])),
                series.length > 2 ? h('span', null, t('trendRange', { days: series.length, peak: maxCalls })) : null,
                h('span', null, dayLabel(series[series.length - 1])),
              )
            : null,
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

      const rangeLabels = useMemo(
        () => ({
          1: t('rangeToday'),
          7: t('range7'),
          30: t('range30'),
          0: t('rangeAll'),
        }),
        [t],
      )

      const load = useCallback(
        async (quiet) => {
          try {
            const next = await fetchSummary(range)
            setSummary(next)
            setError(null)
          } catch (cause) {
            if (!quiet) setError(String(cause?.message ?? cause))
          } finally {
            setLoading(false)
          }
        },
        [range],
      )

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        void (async () => {
          try {
            const next = await fetchSummary(range)
            if (!cancelled) {
              setSummary(next)
              setError(null)
            }
          } catch (cause) {
            if (!cancelled) setError(String(cause?.message ?? cause))
          } finally {
            if (!cancelled) setLoading(false)
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
        setSummary((current) => (current && report ? { ...current, prices: report } : current))
        setTick((value) => value + 1)
      }, [])

      const onReset = useCallback(async () => {
        if (!window.confirm(t('confirmReset'))) return
        setBusy(true)
        try {
          await resetUsage()
          setCollapsed(new Set())
          setTick((value) => value + 1)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [t])

      /** 抓取官网价格页；成功后 Host 会按新价格重算历史花费。 */
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
            ),
          ),
          h(
            'div',
            { className: 'llmu-toolbar' },
            h(
              'div',
              { className: 'llmu-seg', role: 'group', 'aria-label': t('rangeLabel') },
              RANGES.map((value) =>
                h(
                  'button',
                  {
                    key: String(value),
                    type: 'button',
                    'data-active': value === range ? 'true' : 'false',
                    onClick: () => setRange(value),
                  },
                  rangeLabels[value],
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
                value: formatCost(totals.cost),
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
          : summary.platforms.map((platform) =>
              h(PlatformCard, {
                key: platform.provider,
                t,
                platform,
                showCost,
                range: summary.days,
                open: !collapsed.has(platform.provider),
                onToggle: () => onTogglePlatform(platform.provider),
                priceEntry: priceByProvider.get(platform.provider),
                onPriceReport,
              }),
            ),
        h('div', { className: 'llmu-source-note' }, t('sourceNote')),
        h(
          'div',
          { className: 'llmu-foot' },
          h('span', null, t('footerRetention', { days: summary.retainDays })),
          showCost ? h('span', null, t('footerPrice', { file: 'cordis.patch.yml' })) : null,
          h('span', null, t('footerFile', { file: 'llm-usage-insights/usage.json' })),
        ),
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
          const disposers = Object.entries(dictionaries).map(([locale, dict]) =>
            ctx.locale.register(NS, locale, dict),
          )
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
              locale: NS,
            },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_KEY, locale: NS },
            (ownerProps = {}) => h(PanelHost, { locale: ctx.locale, ...ownerProps }),
          ),
        )
      },
    }
  },
})
