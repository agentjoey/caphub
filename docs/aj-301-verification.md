# AJ-301 verification — Telegram Mini App

**Status: NOT YET PERFORMED.** This document is a template. Task 5 Step 4 (deploy + real-device
walkthrough) needs a Human Owner to paste `TELEGRAM_BOT_TOKEN` into Railway's `web` service and to
adjust the Cloudflare Access email-code session duration, then to walk the flow on an iPhone. None
of that happened as part of implementing this task — see the task-5 report for why. Everything
below is the checklist to run and the blanks to fill in once that happens; nothing here should be
read as a completed result until every row says PASS/FAIL and every screenshot exists.

## What Steps 1–3 built (code, already merged into this branch)

- `lib/telegram/api.ts`: `TelegramApi.setChatMenuButton`, `InlineKeyboardButton.web_app`, and the
  `MenuButton` type.
- `lib/telegram/commands.ts`: `syncCommands` now also calls `setChatMenuButton` at worker startup,
  setting a bot-wide `web_app` menu button (text "能力库") pointing at `${publicBaseUrl()}/mini`.
- `lib/telegram/format.ts`: the "🔗 去 web" button in all three card renderers (`formatKeep`
  /kept card, `formatPending`/pending card, `formatTodo`/self-build card) is now a `web_app`
  button opening `${publicBaseUrl()}/mini/library/<id>`, instead of a plain `url` button opening
  `/library/<id>` in the system browser.
- Tests (`lib/telegram/api.test.ts`, `commands.test.ts`, `format.test.ts`) assert against the HTTP
  body that would reach the Telegram API (via `createTelegramApi`'s injected `fetch`), not against
  a fake's captured call arguments — see the M3 lesson referenced in the task brief.

Old messages already sitting in the owner's Telegram chat history keep their old plain-`url`
buttons; they are not retroactively edited.

## Whole-branch review fixes (2026-09-21)

The final whole-branch review found the branch could not work and leaked data. Fixed in this
branch:

- The Telegram SDK (`https://telegram.org/js/telegram-web-app.js`) was never loaded anywhere, so
  `window.Telegram.WebApp` was always undefined. It is now loaded by `app/mini/layout.tsx` with
  `strategy="beforeInteractive"`, scoped to `/mini*` only.
- `TelegramProvider` snapshotted "is Telegram present" through a no-op subscribe, so a script that
  executed after hydration could never flip `ready`. It now subscribes to the script tag's `load`
  event (and `window.load` as a backstop).
- `GET /mini` is cookie-exempt in `lib/auth/guard.ts` (the shell must load before it can exchange
  `initData`), but the page served the whole library to anyone holding a Cloudflare Access session
  and no Telegram — including `?page=N` paging and `?q=…` semantic search, which also spent the
  Gemini embedding key. `app/mini/page.tsx` now verifies the mini cookie itself with the guard's
  own `verifyMiniSession` and renders only the shell without one.
- `/mini` used to render inside the desktop `AppShell`, whose nav would navigate Telegram's WebView
  out of the Mini App. `/mini` now has its own root layout; the desktop routes moved under
  `app/(chrome)/`.
- The mini session cookie is now `SameSite=None; Secure` (see below), the session response carries
  `Cache-Control: no-store`, a failed `initData` exchange shows a visible error instead of failing
  silently, `saveEdit` got the `if (locked) return` guard its siblings have, and the native
  Back/Main button handlers were stabilised so they stop blinking on every `router.refresh()`.

### Cookie SameSite ruling (supersedes the task-1 round-1 ruling)

`caphub_mini` is issued with `SameSite=None; Secure`, and the chat card buttons stay `web_app`
buttons. Telegram Desktop and Telegram Web render a Mini App in a cross-site iframe, where a Lax
cookie is never sent — those clients would 401 on every request.

Evidence that this is safe for writes: Next 16.3.3 enforces an Origin/Host check on every server
action. `node_modules/next/dist/server/app-render/action-handler.js` compares the request's
`origin` header against `Host`/`X-Forwarded-Host` and, on a mismatch that `serverActions.
allowedOrigins` does not cover, logs "does not match `origin` header from a forwarded Server
Actions request. Aborting the action." and throws `Invalid Server Actions request.`
(`__NEXT_ERROR_CODE: "E80"`). The shipped docs state the same:
`node_modules/next/dist/docs/01-app/02-guides/data-security.md` — "Server Actions in Next.js also
compare the Origin header to the Host header (or `X-Forwarded-Host`). If these don't match, the
request will be aborted." `next.config.ts` sets no `allowedOrigins`, so only this host's own
Origin passes. Cloudflare Access and the guard's human-email requirement remain in front of every
`/mini` request on top of that.

## Step 4: deploy (Human Owner — not yet done)

- [ ] Add `TELEGRAM_BOT_TOKEN` to the Railway `web` service (same value as the `worker` service's).
- [ ] Widen the Cloudflare Access email-code session duration so a WebView login doesn't expire
      mid-session.
- [ ] Deploy `web` (and `worker`, to pick up the new `setChatMenuButton` call on next restart).
- [ ] Confirm the worker log shows `setChatMenuButton` succeeding (no `"telegram setChatMenuButton
      failed"` line) after restart.

## Step 4: real-device walkthrough (iPhone Telegram — not yet done)

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Menu button opens `/mini` | ☐ | First open should prompt a Cloudflare Access email code |
| 2 | After the Access code, the capability list is visible | ☐ | |
| 3 | Searching a Chinese keyword returns matching cards | ☐ | |
| 4 | Filter chips narrow the list | ☐ | |
| 5 | A card's "🔗 去 web" button opens that card's detail directly in the Mini App | ☐ | |
| 6 | Deciding a pending card (keep/discard) works, with haptic feedback | ☐ | |
| 7 | Changing a self-build card's progress works, with haptic feedback | ☐ | |
| 8 | Telegram's back gesture/button returns from detail to the list | ☐ | |
| 9 | ...and the list is back in its previous filter/search state, not reset | ☐ | |
| 10 | Toggling the phone's light/dark mode is reflected live in the Mini App | ☐ | |
| 11 | No Caphub desktop header/nav is visible anywhere in the Mini App | ☐ | |
| 12 | Opening `/mini` in a plain browser (Access session, no Telegram) shows only the shell — no cards, no search | ☐ | |
| 13 | A card's "🔗 去 web" button works on Telegram Desktop too (cross-site iframe, `SameSite=None`) | ☐ | |

## Screenshots (real device only — `scripts/shot.mjs` cannot reach a Telegram WebView)

- [ ] Menu button / `/mini` list (light)
- [ ] `/mini` list (dark)
- [ ] Card detail opened from a chat button
- [ ] A decision or progress action mid-flight (haptic feedback has no visual proxy, but capture
      the resulting state change)

Screenshots go under `.agent/screens/aj-301/` once taken, referenced here by relative path.

## Known/expected limitations (fill in if the walkthrough surfaces more)

- Historical Telegram messages sent before this change keep opening `/library/<id>` in the system
  browser via their old plain-`url` button — by design, not a bug (see task-5 brief).
- Anything found during the walkthrough that isn't a pass goes here, with whether it blocks
  release or is a follow-up.

## Sign-off

- [ ] Human Owner confirms the walkthrough above and approves release.
