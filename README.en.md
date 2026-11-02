# llm-usage-insights

Per-provider, per-model usage accounting for DeepSeek Harness: calls, tokens, cost — all local, one click from the sidebar.

- Aggregates calls, failures, aborts, input / output / cache tokens and cost by **provider → model**.
- Cost uses **peak / off-peak windows** and **tiered pricing**; windows are evaluated in UTC+8.
- Prices come from the **provider's official pricing page** when available (manual URL or auto-discovery), falling back to built-in reference prices; the source is always labelled in the UI.
- History is stored in **hourly buckets** (`usage.json` v2), so a day can be drilled down to the hour.
- 30-day retention by default; older buckets are pruned on startup and totals are recomputed so they never drift.
- UI is bilingual and follows the host language.

## Install

Not in the plugin market yet; install it as a local development plugin, then restart the app and open the sidebar entry.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `retainDays` | 30 | Days of per-day detail kept (1–3660). |
| `showCost` | true | Show the cost column and totals. |
| `priceSync` | true | Sync official prices once a day, catching up on next start. |
| `autoDiscover` | true | Auto-discover pricing pages for providers without a feed URL. |
| `priceFeeds` | {} | Preset `provider → pricing-page URL`; the panel input wins. |
| `usdToCny` | 7.1 | Rate for USD prices found on generic pages. |
| `peakHolidays` | [] | Dates (`YYYY-MM-DD`, UTC+8) treated as off-peak. |
| `pricing` | {} | Custom price table keyed by `provider`, `provider/model` or `*`; overrides official prices, all zeros = unpriced. |

Resolution order: **custom `pricing` → official table → built-in estimate**.

## Data & privacy

- Data directory: `$DSH_HOME/llm-usage-insights/` (default `~/.dsh/llm-usage-insights`).
- `usage.json` stores counters, tokens and price sources only — **no prompt or reply content**.
- Writes are atomic (temp file + rename); failures keep a dirty flag and retry.
- HTTP routes are loopback / same-origin only.

## Known limitations

- Auto-discovery needs the host search service (desktop requires a DeepSeek API key).
- Official-page scraping covers **SiliconFlow** and **DeepSeek official** layouts only.
- Peak/off-peak is fixed to UTC+8.
- No multi-instance lock on `usage.json`.
- No CSV / JSON export yet.

## Test

```powershell
node --test "test/*.test.js"
```

## License

MIT, see [LICENSE](./LICENSE).
