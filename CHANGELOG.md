# Changelog

## [Unreleased]

### Added
- 中英双语文档：`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`（MIT）。
- 单元测试（`node --test`，零依赖）：峰谷 / 阶梯计价、汇率折算、v1→v2 迁移、保留期裁剪、价格表优先级、落盘与重开一致性、中英文案键对齐。

### Changed
- 数字格式化跟随界面语言：中文用「万 / 亿」，英文用 K / M / B；不再写死 `zh-CN`。
- 配置项 description 追加英文说明，英文界面下不再只看到中文。
- `UsageStore#setPricer` 返回本次重算的记录条数，便于调用方判断价格表是否真的换了。

## [1.3.3] - 2026-11-02

### Fixed
- 价格兜底键匹配（`${provider}/*`）：平台级通配价之前会被模型级键挡住，导致 `siliconflow2` 等平台落到内置估算价。
- 官方价格同步：抓取失败时保留上一份可用价格表，不再清空成「未定价」。

### Added
- 侧栏「用量统计」入口与 960px 面板：平台折叠、趋势柱、小时下钻、价格来源标记。
- 峰谷与阶梯价、`peakHolidays` 节假日、`usdToCny` 汇率折算。
- 官网价格页自动搜索与逐平台价格页链接编辑。
- `usage.json` v2 小时桶，含 v1 按天数据的自动迁移。
