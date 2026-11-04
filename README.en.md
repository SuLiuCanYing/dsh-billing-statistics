# dsh-billing-statistics

Per-provider, per-model usage and billing accounting for DeepSeek Harness: calls, tokens, estimated cost — all local, one click from the sidebar.

- Aggregates calls, failures, aborts, input / output / cache tokens and cost by **provider → model**.
- Cost uses **peak / off-peak windows** and **tiered pricing**; windows default to UTC+8 (`utcOffsetHours` configurable).
- Amounts are booked at **6 decimal places** (0.000001 CNY); the UI shows 1–3 places by default (<100: 3, ≥100: 2, ≥1000: 1), an eye button next to an amount reveals the full 6-decimal value (like a password reveal) and hides it again, and the HTML report and CSV export use the same 6-decimal precision.
- Prices are looked up automatically from **models.dev**: models are matched by provider and model ID, and USD rates are converted with `usdToCny`; unmatched models fall back to built-in reference prices. The source is always labelled in the UI.
- **DeepSeek official API is detected automatically**: when the provider is `deepseek` / `deepseek-official` / `deepseek-account`, or its base URL host is `api.deepseek.com`, the official peak/off-peak price table is enabled automatically. Opening **Manual import price** first reads the latest official Markdown price list, then falls back to the last cache or the bundled table. This applies only to the official API — DeepSeek models hosted by third parties are not repriced with it.
- When models.dev has no model for the same provider, the row shows a **models.dev reference price** and names the actual source provider — it never pretends to be the platform's official rate.
- If the catalog has no model or the price is wrong, click **Manual import price** on the provider row, fill rates in the table (a blank field keeps its old value), or enable a **peak window** (e.g. `09:00-12:00, 14:00-18:00`, every day / weekdays / weekends) and add peak rates; outside the window the base rate applies. Or download the **CSV template**, fill it in Excel, and import it. Manual prices persist. For the DeepSeek official API, the official auto price applies by default; only an explicit save in the dialog creates a manual override, and **Use official price** restores it. Legacy manual prices on official providers are parked and no longer priced.
- While any provider still uses built-in or models.dev prices (or manual prices cover only some models), the price bar shows a **red reminder**: API rates differ by platform, models.dev has no peak-window prices, and manual import is recommended. It disappears once every platform has a reliable price (manual or the DeepSeek official auto price).
- History is stored in **hourly buckets** (`usage.json` v2), so a day can be drilled down to the hour.
- Export a self-contained **HTML report** or **PDF document**: grouped by provider and model, with time detail under each model and a note when failed calls may make spend look low; choose format, date range, and whether to include time detail before export. CSV remains available as a compatibility endpoint.
- Time ranges: today / last 7 days / last 30 days, plus an **All** view and per-year switches; picking a year shows its 12 months, and All groups usage by year.
- Hourly detail is kept for 30 days by default (configurable) and older buckets are pruned on startup, while **monthly totals are kept long term**, so year and All views never shrink.
- **Official bill reconciliation**: the footer opens a dialog where you pick a provider and date, then enter the official amount, call count (optional), and tokens (optional). It compares them with the plugin's local day totals and labels the gap; leave the call count blank when the provider does not expose it. Official bills require a provider login; the plugin does not store credentials, scrape pages, or log in for you. The official bill remains authoritative.
- UI is bilingual and follows the host language.

## Scope and limits

`dsh-billing-statistics` is a local ledger for DSH model calls: it records calls passing through `llm/stream` by provider, model, and hour, estimates spend from a price table, and adds reports plus official-bill comparison. It does not proxy model requests or log in to provider platforms.

- **Limited scope**: only calls passing through DSH `llm/stream` are counted. Direct API calls, other clients, and traffic while DSH is not running are absent.
- **Estimates, not bills**: spend is derived from models.dev, the official DeepSeek price table, or manual prices. The official bill remains authoritative. Reconciliation needs you to enter the official amount by hand; calls and tokens are optional. The plugin does not scrape bills or store credentials.
- **No budget enforcement**: there are no daily/monthly budgets, request blocking, balance queries, or top-ups. It only records and displays.
- **Price sources are labelled**: catalog prices are references, not contract rates; unmatched models fall back to built-in or manual prices, and the UI shows the source.
- **Local data only**: stored under `$DSH_HOME/llm-usage-insights/`; no cloud sync or multi-machine merge. Uninstalling does not delete the ledger; remove that directory yourself to wipe it.
- **Platform scope**: DSH Web UI, `>=0.2.1-rc.5 <0.3.0`, Node.js `>=20`; verified only on Windows 11 with DSH `0.2.1-rc.5`.
- **PDF limit**: requires `pdfkit`; without a CJK font it fails loudly instead of emitting a garbled report.

## Install

Not in the plugin market yet; install it as a local development plugin, then restart the app and open the sidebar entry.

Compatibility: DSH `>=0.2.1-rc.5 <0.3.0`, Node.js `>=20`; currently verified on Windows 11 with DSH `0.2.1-rc.5` only. See [PLUGIN-DECLARATION.md](PLUGIN-DECLARATION.md) for the full compatibility, permission, and limitation statement.

Upgrading from 1.12.x: the old package name was `dsh-billing-insights` (and `llm-usage-insights` before that). Remove the old bundle in Plugin Manager before installing `dsh-billing-statistics`, so two bundles do not register the same sidebar page. The data directory and API prefix keep their legacy names, so existing ledgers are preserved.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `retainDays` | 30 | Days of per-day detail kept (1–3660); older hourly buckets are pruned, monthly totals are kept long term. |
| `showCost` | true | Show the cost column and totals. |
| `priceSync` | true | Refresh the models.dev catalog once a day, catching up on next start. |
| `usdToCny` | 7.1 | Rate used to convert models.dev USD prices to CNY. |
| `peakHolidays` | [] | Dates (`YYYY-MM-DD`, UTC+8) treated as off-peak. |
| `utcOffsetHours` | 8 | Offset in hours for peak windows and daily buckets (-12..14), 0 = UTC; existing buckets are not re-keyed. |
| `pricing` | {} | Custom price table keyed by `provider`, `provider/model` or `*`; overrides models.dev prices, all zeros = unpriced. |

Resolution order: **custom `pricing` → manual import price → DeepSeek official auto price (official API only) → models.dev catalog → built-in estimate**. On DeepSeek official providers, the official auto price takes precedence over legacy manual prices; only an explicit save in the dialog turns the manual table into an override, and **Use official price** clears it.

The catalog is cached at `$DSH_HOME/llm-usage-insights/models-dev.json` and refreshed daily; on network failure the cache is used, and on first run without a cache the bundled snapshot is the fallback. The DeepSeek official price is fetched at most once an hour, then falls back to the last cache and the bundled table; official peak windows are interpreted in UTC and displayed in local time via `utcOffsetHours`.

## Data & privacy

- Data directory: `$DSH_HOME/llm-usage-insights/` (legacy compatibility directory; default `~/.dsh/llm-usage-insights`).
- `usage.json` stores counters, tokens and price sources only — **no prompt or reply content**; `manual-prices.json` stores only manually imported rates.
- Writes take `usage.lock` for a short critical section, merge on-disk buckets (field-wise max), then write atomically; failures keep a dirty flag and retry.
- If `usage.json` is corrupt at startup, it is first renamed to `usage.json.corrupt-<time>` as a backup, then the plugin starts empty. If even the backup rename fails, it enters read-only mode instead of overwriting the original file.
- HTTP routes are loopback / same-origin only.

## Known limitations

- models.dev covers 200+ providers and 8,000+ models; models it does not list (for example brand-new models on some platforms) are not priced automatically — the UI says so, and **Manual import price** is the reliable fallback.
- A cross-provider reference price comes from another platform with the exact same model ID (the source provider is shown); it may differ from what your platform charges, so enter a manual price if that matters.
- Peak/off-peak and daily buckets follow `utcOffsetHours`; changing it does not re-key existing buckets.
- `usage.json` has a lightweight `usage.lock`, but two instances can only merge buckets field-by-field (max), so concurrent calls in the same hour may be undercounted — keep one window open. Export supports self-contained HTML reports (default), PDF documents, and CSV (compatibility). PDF uses a local Chinese TrueType font (Windows defaults to SimHei); use HTML if no font is available.

## Test

Covers peak/tier pricing and FX, DeepSeek official API detection / official table / Markdown parsing / UTC peak windows, models.dev matching and reference prices, manual import pricing and peak windows, v1→v2 migration, retention, year/all views, price precedence, persistence, corrupt-file backup, and i18n key parity.

```powershell
node --test "test/*.test.js"
```

## License

MIT, see [LICENSE](./LICENSE).
