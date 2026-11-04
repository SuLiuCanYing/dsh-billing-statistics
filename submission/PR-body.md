# Add SuLiuCanYing/dsh-billing-statistics (usage)

Single-entry submission: adds `data/plugins/SuLiuCanYing__dsh-billing-statistics.yml`. Nothing else in this repository is touched.

## What it is

`dsh-billing-statistics` is a local billing ledger for DeepSeek Harness model calls.

- The host half records calls that pass through `llm/stream`: provider, model, success/failure/abort, input/output/cache-hit tokens, and an estimated cost. It keeps hourly buckets (30 days by default, configurable) and long-lived monthly totals, and serves the result through local `/api/llm-usage/v1/*` routes.
- The browser half adds a **Billing stats** sidebar page with year / month / day / hour views, provider and model breakdowns, a trend chart, and a detail table. It is bilingual and follows the host language.
- Prices come from the models.dev catalog (refreshed daily), the DeepSeek official price page (official routes only), or a manual table. Manual prices can be edited per model, imported from a CSV template, and given peak windows such as `09:00-12:00, 14:00-18:00` with everyday/weekday/weekend scopes. The UI labels each price source.
- Exports: self-contained HTML report, PDF document, and CSV. The HTML/PDF report groups by provider/model and can include hourly detail.
- **Official bill reconciliation**: enter the official amount, call count (optional), and tokens (optional) per provider and date; the page compares them with the local day totals and shows the difference. The official bill remains authoritative.

## What it does not do

- It does not proxy or intercept model requests, set daily/monthly budgets, block a turn, query account balance, or top up.
- It does not log in to provider platforms, scrape official bills, or store account credentials. Reconciliation is manual data entry.
- It only sees calls passing through DSH `llm/stream`; direct API calls, other clients, and traffic while DSH is not running are not in the ledger.
- Amounts are estimates from a price table, not a subscription bill. Catalog prices are references, not contract rates.
- Data stays in `$DSH_HOME/llm-usage-insights/`; there is no cloud sync or multi-machine merge. Uninstalling does not delete the ledger.

## Manifest

- Root `package.json` declares `dsh.bundle.patch = "./cordis.patch.yml"`; `cordis.patch.yml` inserts `id: dsh-billing-statistics`, `name: dsh-billing-statistics`.
- `dsh.client.platform = "web"`, so the sidebar page is registered only in the Web UI.
- No runtime dependency on official `@deepseek-ai/*` packages; `@deepseek-ai/schemastery` is an optional peer. `pdfkit` is the only runtime dependency.
- `engines.dsh` is `>=0.2.1-rc.5 <0.3.0`; `engines.node` is `>=20`.
- The data directory and API prefix keep the legacy names `llm-usage-insights` and `/api/llm-usage/v1/*` so an existing ledger survives the package rename; the package, bundle row, and UI names are `dsh-billing-statistics`.

## Verification

- `npm test` runs the repository's Node test suite (store, pricing, exports, API, and package checks).
- The package is built without a compile step and `npm pack` carries only the runtime files listed in `files`.
- Manually exercised on Windows 11 with DSH `0.2.1-rc.5`: sidebar page, price sync, manual price import, HTML/PDF/CSV export, and bill reconciliation.

## Overlap with existing entries

There is real overlap in `usage`, and I would rather flag it than overstate uniqueness:

- `dingchenhui0618-arch/dsh-cost-ledger` also records provider/model tokens and compares a manually entered official bill with local estimates. This entry adds the sidebar year/month/day/hour views, models.dev + DeepSeek automatic price sync, manual peak-window pricing, and HTML/PDF reports.
- `SenmuuuuW/dsh-whale-report` also exports cost/token reports as PDF/HTML. This entry adds the ongoing billing ledger, provider/model price-source handling, and official-bill reconciliation.
- `940842546/dsh-usage-billing` also covers usage/cost and peak/off-peak pricing. This entry adds multi-provider catalog/manual pricing and the report/reconciliation workflow.

If the maintainer judges this a duplicate, closing or narrowing the entry is fine. The description above is limited to features the code actually has.

## Notes

- MIT licensed.
- `icon` points at a 180×180 PNG in the repository, not the package's SVG.
- `tarball` points at a version-free `.tgz` asset on the latest GitHub release, so the link stays valid across releases.
- The repository also carries `submission/` with this entry and PR body; it is excluded from the npm package by `files`.
