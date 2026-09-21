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
