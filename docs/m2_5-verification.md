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
