import type { CapabilityType } from "../analysis/card";
import { errorLabel, progressLabel, typeLabel, usageLabel, type Progress } from "../library/labels";
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
  /** AI value score 1–5, or null/undefined for a card with no score (e.g. scored before M3.5's backfill) — never rendered as a 0. */
  score?: number | null;
  /** Short (≤80 char) reason for `score`, shown inline after it. Ignored when `score` is null/undefined. */
  scoreReason?: string | null;
  /** The capability's `updated_at`, ISO — used to encode the optimistic-lock token in button callback_data. */
  updatedAt: string;
}

/**
 * Input to `formatResult` for a `/todo` self-build card (AJ-298): a kept, `usage='reference'`
 * card with self-build `progress` in `('todo','planned','building')` — see commands.ts's
 * `listTodoCapabilities`. Deliberately narrower than {@link DecidedCardInput}: there is no
 * suggestion to show (the card is already decided), so no `suggestedVerdict`/`suggestedReason`.
 */
export interface TodoCardInput {
  status: "todo";
  id: string;
  title: string;
  type: CapabilityType;
  summary: string;
  tags: string[];
  /** Chinese scenario labels, already resolved from slugs (see lib/analysis/scenarios.ts). */
  scenarioLabels: string[];
  /** Display serial (e.g. "SKL-0007"), or null when the card has none to show. */
  serial: number | null;
  score?: number | null;
  scoreReason?: string | null;
  progress: Progress;
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

export type FormatCardInput = DecidedCardInput | FailedCardInput | TodoCardInput;

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

/**
 * `评分：★4/5 · 理由`, or `null` when there's nothing to show — a null/undefined `score` (never a
 * literal 0; the schema only allows 1–5) omits the whole line rather than rendering `★0/5`.
 * `reason` is already bounded to ≤80 chars by the card schema, so unlike `body`/`tags`/
 * `scenarioLabels` it isn't run through {@link shrinkUntilFits} — it's a fixed-size field, not an
 * unbounded one.
 */
function scoreLine(score: number | null | undefined, reason: string | null | undefined): string | null {
  if (score === null || score === undefined || score < 1) return null;
  const base = `评分：★${score}/5`;
  return reason ? `${base} · ${escapeHtml(reason)}` : base;
}

function formatKeep(card: DecidedCardInput): FormattedMessage {
  const serial = formatSerial(card.type, card.serial);
  const header = serial ? `✅ 已保留 · ${escapeHtml(serial)}` : "✅ 已保留";
  const build = (f: ShrinkableFields) => {
    const lines = [
      header,
      `<b>${escapeHtml(f.title)}</b>`,
      metaLine(card),
      scenariosLine(f.scenarioLabels),
      tagsLine(f.tags)
    ];
    const score = scoreLine(card.score, card.scoreReason);
    if (score) lines.push(score);
    lines.push(libraryLinkHtml(card.id, "详情"));
    return lines.join("\n");
  };
  const text = shrinkUntilFits(build, { title: card.title, tags: card.tags, scenarioLabels: card.scenarioLabels });
  return { text };
}

function formatDiscard(card: DecidedCardInput): FormattedMessage {
  const build = (f: ShrinkableFields) => {
    const lines = ["🗑 已丢弃", `<b>${escapeHtml(f.title)}</b>`, escapeHtml(f.body ?? "")];
    const score = scoreLine(card.score, card.scoreReason);
    if (score) lines.push(score);
    lines.push(libraryLinkHtml(card.id, "详情"));
    return lines.join("\n");
  };
  const text = shrinkUntilFits(build, { title: card.title, tags: [], scenarioLabels: [], body: card.suggestedReason });
  return { text };
}

function suggestedVerdictLabel(v: "keep" | "discard"): string {
  return v === "keep" ? "保留" : "丢弃";
}

/**
 * Renders a pending card as distinct paragraphs separated by blank lines (AJ-298 — the owner
 * reported the previous run-on block read poorly): title, 建议, 总结, 场景·标签, then 评分 (only
 * when the card has one). Every over-budget field is still shrunk on its raw, pre-escape value
 * before assembly (see {@link shrinkUntilFits}), so the paragraph breaks never interact with the
 * length-budget cutting — a dropped tag/scenario/title only ever removes text within a line,
 * never a blank-line separator itself.
 */
function formatPending(card: DecidedCardInput): FormattedMessage {
  const summary = truncate(card.summary, PENDING_SUMMARY_MAX_LEN);
  const build = (f: ShrinkableFields) => {
    const paragraphs = [
      `<b>${escapeHtml(f.title)}</b>`,
      `建议：${suggestedVerdictLabel(card.suggestedVerdict)} · ${escapeHtml(card.suggestedReason)}`,
      `总结：${escapeHtml(f.body ?? "")}`,
      `${metaLine(card)} · ${scenariosLine(f.scenarioLabels)} · ${tagsLine(f.tags)}`
    ];
    const score = scoreLine(card.score, card.scoreReason);
    if (score) paragraphs.push(score);
    return paragraphs.join("\n\n");
  };
  const text = shrinkUntilFits(build, { title: card.title, tags: card.tags, scenarioLabels: card.scenarioLabels, body: summary });
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "✅ 保留", callback_data: encodeDecision("keep", card.id, card.updatedAt) },
        { text: "🗑 丢弃", callback_data: encodeDecision("discard", card.id, card.updatedAt) }
      ],
      [
        { text: "♻️ 重跑分析", callback_data: encodeDecision("rerun", card.id, card.updatedAt) },
        { text: "🔗 去 web", url: libraryLink(card.id) }
      ]
    ]
  };
  return { text, replyMarkup };
}

/**
 * Renders a `/todo` self-build card (AJ-298): title, 总结, 场景·标签, 评分 (when present), 进度 —
 * same paragraph layout as {@link formatPending} minus the 建议 line (the card is already kept,
 * there's no suggestion to show), plus a 进度 line and the 开始自研/已完成/放弃/去 web buttons.
 */
function formatTodo(card: TodoCardInput): FormattedMessage {
  const build = (f: ShrinkableFields) => {
    const paragraphs = [
      `<b>${escapeHtml(f.title)}</b>`,
      `总结：${escapeHtml(f.body ?? "")}`,
      `${scenariosLine(f.scenarioLabels)} · ${tagsLine(f.tags)}`,
      `进度：${escapeHtml(progressLabel(card.progress, "zh"))}`
    ];
    const score = scoreLine(card.score, card.scoreReason);
    if (score) paragraphs.push(score);
    return paragraphs.join("\n\n");
  };
  const text = shrinkUntilFits(build, { title: card.title, tags: card.tags, scenarioLabels: card.scenarioLabels, body: card.summary });
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "🔨 开始自研", callback_data: encodeDecision("progress-building", card.id, card.updatedAt) },
        { text: "✅ 已完成", callback_data: encodeDecision("progress-done", card.id, card.updatedAt) }
      ],
      [
        { text: "🚫 放弃", callback_data: encodeDecision("progress-dropped", card.id, card.updatedAt) },
        { text: "🔗 去 web", url: libraryLink(card.id) }
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
    inline_keyboard: [[{ text: "♻️ 重跑分析", callback_data: encodeDecision(action, card.id, card.updatedAt) }]]
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
      case "todo": return formatTodo(card);
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
