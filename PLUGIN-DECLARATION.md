# dsh-billing-statistics — 插件发布声明

> 本文件是发布包的兼容性与边界声明，不参与运行时加载。DSH 读取的机器可读清单仍是
> `package.json`（`dsh.bundle.patch`、`dsh.client`、`engines.dsh`）。

## 1. 基本信息

| 项目 | 值 |
| --- | --- |
| 包名 | `dsh-billing-statistics` |
| 版本 | `1.13.0` |
| 类型 | Host 插件 + Web Client 页面（Cordis bundle） |
| 许可证 | MIT |
| 插件行 id | `dsh-billing-statistics` |
| Host 入口 | `index.js` → `export function apply(ctx, config)` |
| Client 入口 | `client.js` → `window.__ModuleLoader__.load(...)` |
| Bundle patch | `cordis.patch.yml` |
| 显示资源 | `locale/zh.json`、`locale/en.json`、`icon.svg` |
| 运行依赖 | `pdfkit@0.20.2`（仅 PDF 导出使用） |
| 可选 peer | `@deepseek-ai/schemastery >=3.18.5`（Config 校验；宿主通常已提供） |
| 数据位置 | `$DSH_HOME/llm-usage-insights/`（沿用历史兼容目录），默认 `~/.dsh/llm-usage-insights/` |

### 1.1 命名迁移（1.13.0）

包名经历两次迁移：`llm-usage-insights` → `dsh-billing-insights`（1.12.0）→
`dsh-billing-statistics`（1.13.0）。插件行 id 与页面品牌同步改为 `dsh-billing-statistics`，
1.13.0 进一步把 `insights` 改为 `statistics`，突出“计费统计”的口径。这不改变计量、计价与对账逻辑。

为不丢历史数据、不打断已打开的页面，以下内部标识**保留旧名**：

- 数据目录：`$DSH_HOME/llm-usage-insights/`
- Host API 前缀：`/api/llm-usage/v1/*`

它们不是安装名，不参与插件市场检索；新安装只认 `dsh-billing-statistics`。

## 2. 版本与平台兼容性

### 2.1 已声明范围

| 维度 | 声明 | 说明 |
| --- | --- | --- |
| DSH | `>=0.2.1-rc.5 <0.3.0` | 写入 `package.json` 的 `engines.dsh` |
| Node.js | `>=20` | 使用原生 `fetch`、`AbortSignal.timeout`、`node:test` |
| 界面 | DSH Web UI（桌面版 / `dsh web`） | 只有 Web Client，不提供纯 CLI 面板 |
| 操作系统 | Windows / macOS / Linux | Host 侧只使用 Node 标准库与相对路径，无原生模块 |
| 浏览器 | 当前 DSH Web 支持的现代浏览器 | 依赖宿主提供的 React / Slot / 主题运行时 |

### 2.2 实际验证记录

| 项目 | 验证值 |
| --- | --- |
| DSH | `0.2.1-rc.5`（Desktop） |
| Node.js | `24.21.0` |
| 操作系统 | Windows 11（仅 Windows 实机验证） |
| 安装形态 | 工作区目录 + profile 符号链接；插件行状态 `active` |
| 自动化测试 | `node --test "test/*.test.js"`，全部通过（数量见发布记录） |
| 打包检查 | `pnpm pack --dry-run`，文件清单与声明一致 |

**未验证项：** macOS / Linux 实机、Node 20–23、DSH 0.2.0 及更早版本、DSH 0.3 预览版。
这些组合不承诺可用；如强行安装，需自行承担兼容风险。

### 2.3 版本策略

- 采用语义化版本：补丁版修缺陷与文案，次版本加功能，主版本做不兼容调整。
- 声明范围上界是 `<0.3.0`。DSH 0.3 若改动 Loader / Slot / Web Server API，本版本不保证可加载，
  需要重新验证后再放宽 `engines.dsh`。
- 不通过修改 `engines.dsh` 来“声称”支持未测试的宿主版本；市场会按实际声明做兼容性判断。

## 3. 安装与发布物

发布包提供两种等价形态：

1. **npm tarball**：`dsh-billing-statistics-1.13.0.tgz`，适合 `npm` / `pnpm` / 插件市场安装。
2. **目录 zip**：`dsh-billing-statistics-1.13.0.zip`，解压后由 Plugin Manager 作为本地 bundle 安装。

安装时由宿主/包管理器解析 `pdfkit` 依赖；**不要只手工复制文件而跳过依赖安装**，否则
`index.js` 在导入 PDF 导出模块时会失败。

安装后：

- Host 行 `dsh-billing-statistics` 变为 `active`；
- Web 页面需要刷新一次以加载新的 Client bundle；
- 若宿主提示 bundle 顺序或 peer 依赖问题，按 Plugin Manager 的诊断处理，不要手改 profile 清单。

## 4. 权限与运行边界

本插件不使用 DSH 的账号、凭据或远程会话，也不读取模型请求/响应正文。

### 4.1 使用的宿主能力

| 能力 | 用途 | 边界 |
| --- | --- | --- |
| `llm/stream` 事件 | 包裹模型请求流，读取 provider、model、usage、finish | 只读消费，不改写请求 |
| `ctx.webServer.register` | 注册 `/api/llm-usage/v1/*` 精确路由（历史兼容前缀） | 只注册本插件路由；同源访问 |
| `ctx.effect` / `ctx.on` | 生命周期清理与事件解绑 | 插件卸载时释放 |
| Client Slot | 在侧栏注册统计页 | 只渲染插件页面，不接管宿主其他区域 |
| Config Schema | 读取 `retainDays`、`priceSync`、`usdToCny` 等 | 由宿主校验并持久化 |

### 4.2 网络访问

仅访问以下公开 HTTPS 端点：

| 端点 | 时机 | 内容 |
| --- | --- | --- |
| `https://models.dev/api.json` | 启动补刷 / 每日一次（`priceSync`） | 模型价格目录 |
| `https://api-docs.deepseek.com/quick_start/pricing.md` | 打开官方价格导入前 | DeepSeek 官方价表 Markdown |

不访问官方账单后台，不提交 cookie、token、API key，不上传使用数据。
网络失败时回退到随包快照或本地缓存；离线可用，只是价格可能滞后。

### 4.3 本地写入

| 文件 | 内容 |
| --- | --- |
| `usage.json` | 按平台 × 模型 × 小时的调用、token、金额计数 |
| `prices.json` | 最近一次 models.dev 目录缓存 |
| `manual-prices.json` | 用户手工导入的价格与峰时设置 |
| `models-dev.json` | 目录同步元数据（时间、来源等） |

写入采用临时文件 + rename 的原子方式；多实例通过锁文件串行合并。
导出 HTML / PDF / CSV 由用户主动触发，不自动外发。

## 5. 数据与隐私

- **不采集**：prompt、completion、工具参数、文件内容、账号标识、API key、cookie。
- **会记录**：provider id、model id、调用次数、失败/中止次数、输入/输出/缓存 token、
  按价格规则计算的花费、小时桶时间戳。
- **存储位置**：本机 DSH 数据目录；不上传、不云同步。
- **保留期**：小时明细默认 30 天（`retainDays` 可调）；月汇总与总计长期保留。
- **删除**：页面「清空数据」会清空内存与磁盘记录；卸载插件不会自动删除
  `$DSH_HOME/llm-usage-insights/`，需要时可手工删除该目录。

## 6. 功能边界与已知局限

### 6.1 计量范围

1. **只统计经过 DSH `llm/stream` 的调用。** 直连官方 API 的旁路请求、其他客户端、
   插件未运行期间发生的请求不会进入本地账本。
2. **按请求尝试计数。** 重试、标题生成、压缩、联网搜索等辅助调用是否计入，取决于它们
   是否走同一条 `llm/stream` 链路；不同宿主流路径可能不同。
3. **provider 归属来自事件字段。** 同一 key 被多个客户端使用、或 provider 配置改名时，
   历史行不会自动合并。
4. **失败调用可能低估花费。** 失败请求常常没有完整 usage；页面会提示，但无法还原真实计费。

### 6.2 金额口径

1. 金额是**本地估算**，不是官方账单，也不是发票。
2. 价格来源优先级：人工价 → DeepSeek 官方自动价 → models.dev → 内置参考价；
   页面会标出来源，但目录价可能滞后于平台调价。
3. models.dev 是美元/百万 token，按 `usdToCny` 折算；汇率是配置值，不是实时汇率。
4. DeepSeek 官方峰谷价按 UTC 窗口计算，展示时按 `utcOffsetHours` 位移；
   法定节假日需在 `peakHolidays` 手工补充，插件不内置节假日日历。
5. 缓存 token 的字段命名因 provider 而异；缺失字段按 0 处理，可能造成金额偏低。

### 6.3 官方账单对齐

1. 官方账单通常需要登录平台，且没有给第三方插件读取账单的公开接口；
   本插件**不登录、不保存账号、不抓取后台**。
2. 对齐窗口由用户手动填入官方金额、调用次数（可选）、token（可选），
   对比范围是**单平台 × 单日**，不是单模型，也不跨平台合并。
3. 官方调用次数不是所有平台都提供，留空时该项不参与差额判断。
4. 对齐结果只用于排查差异；**结算以官方账单为准**，插件金额不能用于申诉或报销。
5. 手工填入的官方数字不写入 `usage.json`，关闭窗口后不保留。

### 6.4 展示与导出

1. 金额默认显示 1–3 位小数，眼睛按钮展开 6 位；CSV / HTML / PDF 固定 6 位。
2. PDF 由 `pdfkit` 生成，**必须能找到中文字体**（Windows 的 simhei/simkai/simfang、
   macOS 的 Arial Unicode、Linux 的 Noto CJK/文泉驿等）；都没有时用 `LLMU_PDF_FONT`
   指向一个 TrueType 字体，否则导出会直接报错，不会生成缺字的空报表。
3. 中文字体覆盖取决于运行环境，生僻字或 emoji 可能缺字形。
3. 导出内容包含 provider/model 标识与时间明细；分享前请自行确认是否含敏感项目名。
4. 页面统计随本地数据增长；极大历史量下的首次渲染耗时取决于宿主性能，未做虚拟列表。

### 6.5 时区与历史

- `utcOffsetHours` 默认 `8`（北京时间），影响日键、小时桶与页面日期边界。
- 修改偏移不会回溯重写已落盘的小时桶；跨偏移查看历史时可能出现边界差异。
- 小时明细裁剪后，年份/全部视图仍使用长期月汇总，不会因裁剪而缩小。

## 7. 安全与完整性

- 发布包不包含账号、密钥、cookie、个人路径或运行日志。
- 提供 SHA-256 校验文件；校验值随发布产物生成，不宣称数字签名。
- `index.js` 以普通 Cordis 插件运行，未申请额外沙箱权限；其文件访问范围由 DSH 进程权限决定。
- 若从非本仓库来源获取包，请先核对包名、版本、文件清单与校验值。

## 8. 变更与支持

- 详细变更见 `CHANGELOG.md`；使用说明见 `README.md` / `README.en.md`。
- 兼容范围以本文件与 `package.json` 的 `engines.dsh` 为准；两者不一致时，以 `package.json` 为准。
- 本声明随版本更新；旧版本声明不适用于新包。
