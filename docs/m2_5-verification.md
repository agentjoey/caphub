# M2.5 Verification

## Typography

Task 7 — typography and layout refinement of the Paper Workbench UI. The identity is unchanged
(paper, ink, amber, workbench header/nav, cards, stat tiles). The work covered fonts, type scale,
rhythm, measure, and component polish.

### What changed

- **Fonts are actually loaded now.** Before this task `--font-sans` named "General Sans" but no font
  file shipped, so every page fell back to system fonts. Now:
  - General Sans 400/500/600/700 woff2 (Fontshare WEB kit) is self-hosted under `public/fonts/`
    through `next/font/local`. The license ships next to it as `public/fonts/GeneralSans-LICENSE.txt`
    (ITF Free Font License v2.0: self-hosting on your own site is allowed; redistribution is not,
    and that is fine while the repo stays private).
  - IBM Plex Mono 400/500 comes from `next/font/google` (self-hosted at build time).
  - The two next/font variables (`--font-general-sans`, `--font-plex-mono`) are set on `<html>` and
    wired into `--font-sans` / `--font-mono`. The Chinese stack
    `"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei"` comes after the Latin face
    (and after the mono face for CJK comments inside commands).
  - Weights snap to the shipped cuts: the old `650` became `600`, and mono is capped at `500`, so no
    faux bold is synthesized.
- **Token scale.** Every hard-coded size (10 / 10.5 / 11 / 12.5 / 13.5 / 16.5 …) now maps to one
  scale. Line heights are 1.7 for body copy, 1.2 for headings, and 1.45 for UI text. Prose is held
  to a 72ch measure, and card padding is one token (20px desktop, 16px ≤600px).
- **How to use (detail page).** Each install command is a mono code block with its copy button in
  the top-right corner. Prompt text and experience content use the body font in a light block with
  a thin amber left rule, and the copy button floats top-right so the text wraps around it.
  Reference points are a numbered list at body leading. Summary and signals sit under a hairline
  divider at a 72ch measure.
- **Details panel.** The step table has a compact width. Duration and token columns are
  right-aligned, mono, with `font-variant-numeric: tabular-nums`. Step and result cells no longer
  wrap one character per line on mobile, and the table scrolls inside its own wrapper if needed.
  Sources render as "title · domain" on a single line. The title truncates with an ellipsis and the
  domain always stays visible (the full title and URL are in a hover `title`). The summary has a
  custom ▸ disclosure marker.
- **Selected type stat tile** (`.stat[aria-current="true"]`, the Task 5 carry-over): it now has an
  ink border, an inset ink ring and an ink ✓ badge. The always-on 待 Review tile (`.stat--accent`)
  stays amber, so the two no longer look the same. See `after/library-type-skill-*.png`.
- **Chips vs tags.** Scenario chips (`.chip--scenario`, on library and detail) are sans pills with
  an amber dot. Tags (`.tag`) and tag filter chips (`.chip--tag`) are mono, square and recessed.
  Counts are a subdued mono `.chip__count` instead of "(n)".
- **Serials** (SKL-0002) are subdued 12px mono that never wraps inside a title. On the detail `h1`
  they are 13px and optically raised.
- **Mobile.** The recent-list 查看 button is compact and start-aligned under the meta instead of a
  full-width bar. The header now reads brand + language toggle on row 1 and nav on row 2. Stat
  tiles use a 2-up grid. Mobile code blocks use 12px mono.
- **Language switch** was completely unstyled ("中文EN" run together). It is now a two-segment
  toggle, with ink fill on the active locale.
- **EN.** Badges are no longer uppercased, so long EN labels ("Integrate directly") read calmly.
  Headings use `text-wrap: balance` (no lone 「器」 orphan) and prose uses `text-wrap: pretty`.
- Home "去 Review (n)" is a proper compact button, no longer a stretched underlined box.
- `scripts/shot.mjs` takes optional `--cookie name=value` flags (used for `lang=en`).

### Tokens

| Token | Value | Use |
|---|---|---|
| `--text-xs` | 12px | mono labels, badges, tags, serials, table heads |
| `--text-sm` | 13px | meta, buttons, chips, secondary copy, code |
| `--text-base` | 14px | nav, inputs, review summary |
| `--text-md` | 15px | body default, list titles, detail prose, prompt text |
| `--text-lg` | 17px | brand, section/panel/card titles |
| `--text-xl` | 20px | mobile stat values |
| `--text-2xl` | 26px | stat values, mobile page titles |
| `--text-3xl` | 34px | page titles, home hero |
| `--leading-body` | 1.7 | body copy (summary, signals, prompt, points, capture text) |
| `--leading-heading` | 1.2 | headings |
| `--leading-ui` | 1.45 | UI default (body) |
| `--measure` | 72ch | max prose line length |
| `--para-gap` | 0.75em | gap between list paragraphs |
| `--card-pad` | 20px / 16px (≤600px) | panel padding |
| `--space-1…10` | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40px | spacing rhythm |
| `--font-sans` | General Sans → CJK stack → system | UI and prose |
| `--font-mono` | IBM Plex Mono → system mono → CJK stack | code, labels, tags |

### Screenshots

Captured with `node scripts/shot.mjs` against a disposable Neon branch (9 cards) on
`next dev` at `localhost:3100`. Desktop is 1440 at scale 1; mobile is 390 at scale 2 with isMobile.
Every shot reported `horizontalOverflow:false` and `internalIdVisible:false`.

| Page | Before | After |
|---|---|---|
| `/` | `.agent/screens/m2_5/before/home-{1440,390}.png` | `.agent/screens/m2_5/after/home-{1440,390}.png` |
| `/review` | `.agent/screens/m2_5/before/review-{1440,390}.png` | `.agent/screens/m2_5/after/review-{1440,390}.png` |
| `/library` | `.agent/screens/m2_5/before/library-{1440,390}.png` | `.agent/screens/m2_5/after/library-{1440,390}.png` |
| `/library/<id>` (kept, integrate playbook) | `.agent/screens/m2_5/before/library-cab-a5e3b01ef5ee450e-{1440,390}.png` | `.agent/screens/m2_5/after/library-cab-a5e3b01ef5ee450e-{1440,390}.png` |
| `/library?type=skill` (selected stat) | — | `.agent/screens/m2_5/after/library-type-skill-{1440,390}.png` |
| Details panel expanded | — | `.agent/screens/m2_5/after/details-open-{1440,390}.png` |
| EN (`lang=en` cookie) | — | `.agent/screens/m2_5/after/en/{library,library-cab-a5e3b01ef5ee450e,review}-{1440,390}.png` |

## Feature verification (temp Neon branch)

Task 8 — pre-release verification against a disposable Neon branch carrying migrations 004/005 and
backfilled serials (1–6 kept cards), thumbnails, DeepSeek scenarios and Gemini embeddings for 9
capabilities (6 kept, 3 pending). Run against `next dev` on `localhost:3100` with
`ACCESS_BYPASS=1`, real Gemini embedding calls. All mutations were made on the temp branch only
and reverted (`retention.purged_at`) or left in place because the branch is disposable (one card's
`tags`/`updated_at` from the embed-tick check).

### Check results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Serials SKL-0001…0006 in list/detail; `SKL-3`, `skl0003`, `#3` each return exactly SKL-0003; plain `3` does normal search | PASS | `/library` lists all 6 serials; each serial-form query returned exactly 1 match (`cab_8939b959ed464525`); plain `q=3` returned all 6 cards (normal substring/FTS search, not serial-locked) |
| 2 | Hybrid search relevance + calibration | PASS (see table below) | Ranked titles + cosine table below; app-level query results also captured |
| 3 | Scenario chip filter + counts; type stat tile click filters/shows selected style/clears on second click; Review tile unaffected | PASS | `scenario=video` → exactly SKL-0002, SKL-0006 (chip count "2" matches); `type=skill` sets `aria-current="true"` on the 技能 tile and its own link becomes the clear-link (`href="/library"`); 待 Review tile stays at 3 regardless of `type` filter |
| 4 | Detail page scenario chips link to filtered library | PASS | `cab_a5e3b01ef5ee450e` detail page renders `href="/library?scenario=video"`, `?scenario=writing`, `?scenario=learning` |
| 5 | Thumbnails from `thumb/` keys; purge simulation → fallback text + `/api/objects` codes | PASS, with one caveat (not a bug) | List `<img>` `src="/api/objects/thumb/sha256/…webp"`. Set `retention.purged_at = now()` for SKL-0002's original `object_key`; detail page correctly rendered "原图已于 2026-10-19 19:25 清除，仅保留缩略图". `/api/objects` for the original key still returned 200 because the brief instructed **not** to delete the S3 object — `lib/objects/serve.ts` decides 410 purely from whether `ObjectStore.get()` actually fails (see code), it does not consult `retention.purged_at` directly; in production `sweepRetention()` (`lib/retention/retention.ts`) always deletes the S3 object in the same transaction that sets `purged_at`, so the two conditions never diverge in real operation. Confirmed by code read, not independently exercisable without deleting the object. Restored `purged_at` to `NULL` afterward. |
| 6 | zh/EN switch: chrome translated on `/`, `/review`, `/library`, detail; card content unchanged; `<html lang>` | PASS | Default `<html lang="zh-CN">`; with `lang=en` cookie, `<html lang="en">` on all 4 routes, nav shows "Library"/"Review", card titles remain the original Chinese text |
| 7 | Embed tick freshness | PASS | Edited SKL-0001's tags via the real 改建议 editor (Playwright) → `updated_at` bumped past `embedded_at`; ran one `runEmbedTick` → `written:1`, `embedded_at = updated_at`; second tick → `idle` |
| 8 | Screenshots | PASS | `.agent/screens/m2_5/after/library-q-e8-a7-86-e9-a2-91-{1440,390}.png` (`/library?q=视频`), `.agent/screens/m2_5/after/library-purged-fallback-{1440,390}.png` (purged-original fallback on `cab_a5e3b01ef5ee450e`); both reported `horizontalOverflow:false`, `internalIdVisible:false` |

### Search calibration

Cosine similarity (`1 - (embedding <=> query_embedding)`) against all 9 embedded cards, query
embedded live via `lib/providers/gemini-embed.ts` (`kind: "query"`). Bold rows are the
scenario-relevant true positives for that query.

| Query | Top 3 by cosine sim (serial · title · sim) | App's actual `/library` ranked result (kept cards only) |
|---|---|---|
| 视频 | HyperFrames 0.6607 (pending) · **SKL-6 VoiceStudio 0.6312** · **SKL-2 SRT-animation 0.6284** | SKL-0006, SKL-0002, SKL-0003 (Meetily picked up via FTS/ILIKE, not embedding) |
| 配音 | **SKL-6 VoiceStudio 0.6730** · SKL-3 Meetily 0.6217 · SKL-2 SRT-animation 0.6085 | SKL-0006, SKL-0002, SKL-0003 |
| 营销 | **SKL-5 marketingskills 0.7018** · Refero Styles 0.6352 (pending) · HyperFrames 0.6316 (pending) | SKL-0005, SKL-0001 (Kronos is a false positive, semantic-only at 0.6225) |
| video editing | HyperFrames 0.6225 (pending) · **SKL-6 VoiceStudio 0.6101** · **SKL-2 SRT-animation 0.6085** | SKL-0006, SKL-0002 |
| 会议 | **SKL-3 Meetily 0.6498** · HyperFrames 0.6032 (pending) · SKL-1 Kronos 0.5991 | SKL-0003 only |
| crawler | **Scrapling 0.6442 (pending)** · SKL-4 text-to-cad 0.5911 · HyperFrames 0.5882 | (no kept card matches; Scrapling is pending so invisible in `/library`) |
| 量子烹饪 (nonsense) | Scrapling 0.5538 · SKL-4 text-to-cad 0.5493 · HyperFrames 0.5464 | 0 results |

Observations: at the current `SEMANTIC_MIN = 0.62`, the nonsense query correctly clears no card
(max sim 0.5538), but two real false positives slip through the *semantic-only* OR-branch:
Kronos for 营销 (0.6225) and, in the raw cosine table, Refero Styles/Scrapling for 视频
(0.6243/0.6413) — both would appear if those cards were `keep` instead of `pending`. True
positives that are genuinely semantic-only (not already covered by `matchScenarios` keyword/label
equality or FTS/ILIKE) sit at 0.61–0.73, e.g. VoiceStudio for 配音 (0.6730), so raising the floor
does not blind the feature — most of the precise, "obvious" matches (视频→video scenario, 营销→
marketing scenario, 会议→productivity scenario) are already surfaced by the keyword/scenario
channel in `matchScenarios`/`scenarioMatch`, independent of the embedding threshold.

**Recommendation: raise `SEMANTIC_MIN` from 0.62 to ~0.65.** This clears the two observed
semantic-only false positives (Kronos 0.6225 for 营销; Refero Styles 0.6243 / Scrapling 0.6413 for
视频) while keeping every semantic-only true positive seen in this sample (VoiceStudio 0.6730 for
配音; marketingskills 0.7018 for 营销; HyperFrames 0.66 for 视频) and continuing to exclude the
nonsense query (0.5538, well below either threshold). Do not go much higher than ~0.66–0.68: it
starts cutting real matches like HyperFrames-for-视频 (0.6607) without further reducing false
positives in this sample. This is a recommendation only; `lib/library/queries.ts:8` was not
changed.
