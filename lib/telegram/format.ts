import type { CapabilityType } from "../analysis/card";
import { errorLabel, typeLabel, usageLabel } from "../library/labels";
import { formatSerial } from "../library/serial";
import { escapeHtml, type InlineKeyboardMarkup } from "./api";
import { publicBaseUrl } from "./capture";
import { encodeDecision } from "./router";
import type { DecisionAction } from "./router";

/** Summaries are truncated to this many codepoints in the "pending" card. */
export const PENDING_SUMMARY_MAX_LEN = 300;

/**
 * Telegram's hard limit on a message's text length. `PENDING_SUMMARY_MAX_LEN` already bounds the
 * summary, but an unbounded title, tags list, or scenarios set could otherwise still push a
 * card's rendered text past this. Every formatter shrinks its own over-budget fields (see
 * {@link shrinkUntilFits}) *before* escaping/assembly, so the resulting HTML is always
 * well-formed — cutting the already-assembled HTML by raw codepoint (as an earlier version of
 * this cap did) can sever a tag or an escaped entity mid-way, which Telegram then rejects
 * outright with a 400 "can't parse entities" instead of sending a shorter-but-valid message.
 */
export const TELEGRAM_MESSAGE_MAX_LEN = 4096;

export type ResultStatus = "keep" | "discard" | "pending" | "failed";

/**
 * Input to `formatResult` for a card with a decided verdict (`keep`/`discard`) or awaiting
 * one (`pending`). `status` is decided by the caller (`notify.ts`) from the capability's
 * verdict plus the capture's latest analysis run state — this module only renders, it never
 * queries or interprets DB state.
 */
export interface DecidedCardInput {
  status: "keep" | "discard" | "pending";
  id: string;
  title: string;
  type: CapabilityType;
  usage: "integrate" | "reference";
  suggestedVerdict: "keep" | "discard";
  suggestedReason: string;
  summary: string;
  tags: string[];
  /** Chinese scenario labels, already resolved from slugs (see lib/analysis/scenarios.ts). */
  scenarioLabels: string[];
  /** Display serial (e.g. "SKL-0007"), or null when the card has none to show. */
  serial: number | null;
  /** The capability's `updated_at`, ISO — used to encode the optimistic-lock token in button callback_data. */
  updatedAt: string;
}

/**
 * Input to `formatResult` for a failed analysis run. Deliberately narrow — a failed run may
 * never have produced a capability (no title/summary/tags/etc. to show), so this only carries
 * what the failed card actually needs: an id to build the rerun button and the web link, the
 * error code, and the `updated_at` to encode into the rerun callback's optimistic-lock token.
 * This keeps `format.ts` ready for a future second selection branch (a failed run with no
 * capability row) without widening the other three formatters' required fields.
 */
export interface FailedCardInput {
  status: "failed";
  id: string;
  updatedAt: string;
  errorCode: string | null;
  /**
   * What `id` identifies, and therefore which callback action the rerun button encodes.
   * `"capability"` (the default, when omitted) is the original branch — a failed *rerun* of an
   * already-decided card, where `id` is the capability id and the button encodes `"rerun"`
   * (decide.ts reloads the capability and calls `requestRerun` with its `captureId`).
   * `"capture"` is a capture whose first analysis run failed, so no capability row exists yet —
   * `id` is the capture id itself, and the button encodes `"rerun-capture"` so decide.ts calls
   * `requestRerun` directly with `id` rather than trying to load a nonexistent capability.
   */
  target?: "capability" | "capture";
}

export type FormatCardInput = DecidedCardInput | FailedCardInput;

export interface FormattedMessage {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/** Splits on codepoints (not UTF-16 code units) so a cut never lands mid-surrogate-pair. */
function truncate(text: string, maxLen: number): string {
  const codepoints = Array.from(text);
  return codepoints.length <= maxLen ? text : codepoints.slice(0, maxLen).join("");
}

function libraryLink(id: string): string {
  return `${publicBaseUrl()}/library/${id}`;
}

/** An HTML anchor to a card's library page, labeled with `label` rather than showing the raw URL (and its internal id) as visible text. */
function libraryLinkHtml(id: string, label: string): string {
  return `<a href="${escapeHtml(libraryLink(id))}">${escapeHtml(label)}</a>`;
}

function withinMessageLimit(text: string): boolean {
  return Array.from(text).length <= TELEGRAM_MESSAGE_MAX_LEN;
}

/** Card-derived plain-text (pre-escape) fields a formatter may need to shrink to fit {@link TELEGRAM_MESSAGE_MAX_LEN}. `body` is whichever free-text field the formatter has (the pending card's summary, or the discard card's suggested reason) — shrunk first, ahead of tags/scenarios/title. */
interface ShrinkableFields {
  title: string;
  tags: string[];
  scenarioLabels: string[];
  body?: string;
}

/** Truncates a plain-text field in decreasing steps, stopping as soon as `build` fits — tried before falling back to the next, lower-priority field. */
function shrinkString(build: (value: string) => boolean, value: string): string {
  for (const len of [200, 100, 50, 20, 0]) {
    if (Array.from(value).length <= len) continue;
    const shrunk = truncate(value, len);
    if (build(shrunk)) return shrunk;
    value = shrunk;
  }
  return value;
}

/** Drops list items from the end (largest-to-smallest halving) until `build` fits, or the list is empty. */
function shrinkList<T>(build: (value: T[]) => boolean, value: T[]): T[] {
  let count = value.length;
  while (count > 0) {
    count = Math.floor(count / 2);
    if (build(value.slice(0, count))) return value.slice(0, count);
  }
  return [];
}

/**
 * Progressively shrinks a card's over-budget plain-text fields — in priority order `body`
 * (summary/reason), then `tags`, then `scenarioLabels`, then `title` — until `build`'s fully
 * assembled+escaped HTML fits {@link TELEGRAM_MESSAGE_MAX_LEN}. Every shrink happens on the raw,
 * pre-escape value, so the reassembled markup is always well-formed: a cut can never land inside
 * a tag or an escaped HTML entity, unlike truncating the finished HTML string.
 */
function shrinkUntilFits(build: (f: ShrinkableFields) => string, initial: ShrinkableFields): string {
  const f: ShrinkableFields = { ...initial, tags: [...initial.tags], scenarioLabels: [...initial.scenarioLabels] };
  let text = build(f);
  if (withinMessageLimit(text)) return text;

  if (f.body !== undefined) {
    f.body = shrinkString((v) => withinMessageLimit(build({ ...f, body: v })), f.body);
    text = build(f);
    if (withinMessageLimit(text)) return text;
  }

  f.tags = shrinkList((v) => withinMessageLimit(build({ ...f, tags: v })), f.tags);
  text = build(f);
  if (withinMessageLimit(text)) return text;

  f.scenarioLabels = shrinkList((v) => withinMessageLimit(build({ ...f, scenarioLabels: v })), f.scenarioLabels);
  text = build(f);
  if (withinMessageLimit(text)) return text;

  f.title = shrinkString((v) => withinMessageLimit(build({ ...f, title: v })), f.title);
  return build(f);
}

function metaLine(card: DecidedCardInput): string {
  return `类型：${escapeHtml(typeLabel(card.type, "zh"))} · 用法：${escapeHtml(usageLabel(card.usage, "zh"))}`;
}

function scenariosLine(labels: string[]): string {
  return `场景：${labels.map(escapeHtml).join("、") || "无"}`;
}

function tagsLine(tags: string[]): string {
  return `标签：${tags.map(escapeHtml).join("、") || "无"}`;
}

function formatKeep(card: DecidedCardInput): FormattedMessage {
  const serial = formatSerial(card.type, card.serial);
  const header = serial ? `✅ 已保留 · ${escapeHtml(serial)}` : "✅ 已保留";
  const build = (f: ShrinkableFields) =>
    [
      header,
      `<b>${escapeHtml(f.title)}</b>`,
      metaLine(card),
      scenariosLine(f.scenarioLabels),
      tagsLine(f.tags),
      libraryLinkHtml(card.id, "详情")
    ].join("\n");
  const text = shrinkUntilFits(build, { title: card.title, tags: card.tags, scenarioLabels: card.scenarioLabels });
  return { text };
}

function formatDiscard(card: DecidedCardInput): FormattedMessage {
  const build = (f: ShrinkableFields) =>
    ["🗑 已丢弃", `<b>${escapeHtml(f.title)}</b>`, escapeHtml(f.body ?? ""), libraryLinkHtml(card.id, "详情")].join("\n");
  const text = shrinkUntilFits(build, { title: card.title, tags: [], scenarioLabels: [], body: card.suggestedReason });
  return { text };
}

function suggestedVerdictLabel(v: "keep" | "discard"): string {
  return v === "keep" ? "保留" : "丢弃";
}

function formatPending(card: DecidedCardInput): FormattedMessage {
  const summary = truncate(card.summary, PENDING_SUMMARY_MAX_LEN);
  const build = (f: ShrinkableFields) =>
    [
      `<b>${escapeHtml(f.title)}</b>`,
      `建议：${suggestedVerdictLabel(card.suggestedVerdict)} · ${escapeHtml(card.suggestedReason)}`,
      escapeHtml(f.body ?? ""),
      metaLine(card),
      scenariosLine(f.scenarioLabels),
      tagsLine(f.tags)
    ].join("\n");
  const text = shrinkUntilFits(build, { title: card.title, tags: card.tags, scenarioLabels: card.scenarioLabels, body: summary });
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "保留", callback_data: encodeDecision("keep", card.id, card.updatedAt) },
        { text: "丢弃", callback_data: encodeDecision("discard", card.id, card.updatedAt) }
      ],
      [
        { text: "重跑分析", callback_data: encodeDecision("rerun", card.id, card.updatedAt) },
        { text: "去 web", url: libraryLink(card.id) }
      ]
    ]
  };
  return { text, replyMarkup };
}

function formatFailed(card: FailedCardInput): FormattedMessage {
  const reason = errorLabel(card.errorCode, "zh");
  const text = `❌ 分析失败 · ${escapeHtml(reason)}`;
  const action: DecisionAction = card.target === "capture" ? "rerun-capture" : "rerun";
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "重跑", callback_data: encodeDecision(action, card.id, card.updatedAt) }]]
  };
  return { text, replyMarkup };
}

/**
 * Renders a card's Telegram push in Chinese HTML (`parse_mode: "HTML"`). Pure — no network,
 * no DB. All card-derived text is escaped via {@link escapeHtml}; internal ids (`cab_…`,
 * `cap_…`, `run_…`) are never rendered as text, only the display serial (`SKL-0007`).
 */
export function formatResult(card: FormatCardInput): FormattedMessage {
  const rendered = ((): FormattedMessage => {
    switch (card.status) {
      case "keep": return formatKeep(card);
      case "discard": return formatDiscard(card);
      case "pending": return formatPending(card);
      case "failed": return formatFailed(card);
    }
  })();
  return { ...rendered, text: capMessageSafely(rendered.text) };
}

/**
 * Last-resort defensive net after each formatter's own field-level shrinking (see
 * {@link shrinkUntilFits}) — should never actually trigger in practice. Drops whole trailing
 * lines (a safe cut point: this module never wraps markup across a line break) instead of
 * cutting the assembled HTML by raw codepoint, which could sever a tag or an escaped entity and
 * make Telegram reject the message outright with a 400 "can't parse entities".
 */
function capMessageSafely(text: string): string {
  if (withinMessageLimit(text)) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && !withinMessageLimit(lines.join("\n"))) lines.pop();
  return lines.join("\n");
}
