# M2 verification (2026-09-19)

Environment: temporary Neon branch `m2-verify` (copy of production `caphub`, deleted afterwards), migrations 001–003 applied, `scripts/seed-demo.ts` demo cards; local `next dev` on :3100 with the web service's Railway variables (DATABASE_URL overridden to the temp branch), `ACCESS_BYPASS=1`.

## Browser flow checks (Playwright, 18/18 pass)

| Check | Result |
|---|---|
| Review lists the pending demo cards | PASS |
| 保留 persists `verdict=keep, verdict_by=human` | PASS |
| Tag counts bumped on human keep (`prompt-engineering`, `summarization` → 1) | PASS |
| Two tabs on one card: second shows 已在别处处理 | PASS |
| First decision wins in DB (`discard`) | PASS |
| Detail shows the install command | PASS |
| Invalid tag rejected (`爬虫` → 标签不合法) | PASS (first attempt used "Web Scraping", which the editor correctly splits into two valid tags) |
| 复核 request persisted (`review_requested_at`) and page shows 复核中 | PASS |
| Delete after a review request (lock token still valid) → redirect to /library, soft-deleted, gone from list | PASS |
| Library full-text search (`tavily`), tag filter, 已丢弃 toggle, stats bar | PASS |
| Submit page uses the v1 workbench + custody strip; no internal ids | PASS |

Found and fixed during verification: detail page overflowed to ~4000px on long `<pre>` content (wrap + `min-width:0`); pagination shown with a single page; screenshot checker counted `<script>` payload text as visible ids (false positive).

Environment note: `next dev` blocks dev assets for origin `127.0.0.1`; use `localhost` for local browser checks.

## Screenshots (`.agent/screens/m2/`)

`/`, `/review`, `/library`, `/library/<experience card>` at 1440×900 and 390×844 (DPR 2). All: no horizontal overflow, no visible internal id.

## Known polish items (not blocking)

- On ≤720px the recent-list 查看 buttons are full width (inherited v1 mobile rule).
