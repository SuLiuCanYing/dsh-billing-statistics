# Submission notes

This folder is for the `awesome-dsh-plugin` listing. It is not part of the npm package (`files` does not include it).

- `data-plugins-entry.yml` — the exact entry to copy into `awesome-dsh-plugin/data/plugins/SuLiuCanYing__dsh-billing-statistics.yml`.
- `PR-body.md` — PR title and body.

## Before opening the PR

1. The public repo `SuLiuCanYing/dsh-billing-statistics` must exist, be public, and carry the `dsh-plugin` topic.
2. The repo must be at least 1 day old; GitHub's submission gate checks this automatically.
3. Open a PR against `awesome-dsh-plugin/awesome-dsh-plugin` that adds **only** the entry file above. Do not edit either generated README, `data/screenshots.json`, or any other entry.
4. If the PR is labeled `held: author`, push the fix to the same branch and leave one comment describing it.

## What not to claim

The entry describes only what the code does. It is a local ledger and reporting UI; it does not block requests, manage budgets, query balances, or log in to provider platforms.
