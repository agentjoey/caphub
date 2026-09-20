import type { CapabilityType } from "../analysis/card";
import { errorLabel, typeLabel, usageLabel } from "../library/labels";
import { formatSerial } from "../library/serial";
import { escapeHtml, type InlineKeyboardMarkup } from "./api";
import { publicBaseUrl } from "./capture";
import { encodeDecision } from "./router";

/** Summaries are truncated to this many codepoints in the "pending" card. */
export const PENDING_SUMMARY_MAX_LEN = 300;

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
  const lines = [
    header,
    `<b>${escapeHtml(card.title)}</b>`,
    metaLine(card),
    scenariosLine(card.scenarioLabels),
    tagsLine(card.tags),
    escapeHtml(libraryLink(card.id))
  ];
  return { text: lines.join("\n") };
}

function formatDiscard(card: DecidedCardInput): FormattedMessage {
  const lines = [
    "🗑 已丢弃",
    `<b>${escapeHtml(card.title)}</b>`,
    escapeHtml(card.suggestedReason),
    escapeHtml(libraryLink(card.id))
  ];
  return { text: lines.join("\n") };
}

function suggestedVerdictLabel(v: "keep" | "discard"): string {
  return v === "keep" ? "保留" : "丢弃";
}

function formatPending(card: DecidedCardInput): FormattedMessage {
  const summary = truncate(card.summary, PENDING_SUMMARY_MAX_LEN);
  const lines = [
    `<b>${escapeHtml(card.title)}</b>`,
    `建议：${suggestedVerdictLabel(card.suggestedVerdict)} · ${escapeHtml(card.suggestedReason)}`,
    escapeHtml(summary),
    metaLine(card),
    scenariosLine(card.scenarioLabels),
    tagsLine(card.tags)
  ];
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
  return { text: lines.join("\n"), replyMarkup };
}

function formatFailed(card: FailedCardInput): FormattedMessage {
  const reason = errorLabel(card.errorCode, "zh");
  const text = `❌ 分析失败 · ${escapeHtml(reason)}`;
  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "重跑", callback_data: encodeDecision("rerun", card.id, card.updatedAt) }]]
  };
  return { text, replyMarkup };
}

/**
 * Renders a card's Telegram push in Chinese HTML (`parse_mode: "HTML"`). Pure — no network,
 * no DB. All card-derived text is escaped via {@link escapeHtml}; internal ids (`cab_…`,
 * `cap_…`, `run_…`) are never rendered as text, only the display serial (`SKL-0007`).
 */
export function formatResult(card: FormatCardInput): FormattedMessage {
  switch (card.status) {
    case "keep": return formatKeep(card);
    case "discard": return formatDiscard(card);
    case "pending": return formatPending(card);
    case "failed": return formatFailed(card);
  }
}
