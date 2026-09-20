import type { Pool } from "pg";
import { loadScenarios } from "../analysis/scenarios";
import type { Config } from "../config";
import { typeLabel } from "../library/labels";
import { embedSearchQuery } from "../library/query-embedding";
import { listLibrary, type CapabilityRow, type LibraryFilter } from "../library/queries";
import { matchScenarios } from "../library/scenario-match";
import { displaySerial, parseSerialQuery } from "../library/serial";
import { escapeHtml, type TelegramApi } from "./api";
import { publicBaseUrl } from "./capture";

/** At most this many hits are shown in one reply; the rest are pointed at the web instead. */
export const SEARCH_RESULT_LIMIT = 5;

const NO_RESULTS_TEXT = "没找到，换个词试试，或者去 web 看看";

export interface SearchDeps {
  pool: Pool;
  api: Pick<TelegramApi, "sendMessage">;
  /** Only `providers.geminiApiKey` is read (query embedding) — narrow on purpose so tests don't need a full Config. */
  config: Pick<Config, "providers">;
}

export interface SearchParams {
  chatId: number;
  messageId: number;
  query: string;
}

export type SearchOutcome =
  | { kind: "results"; total: number; shown: number }
  | { kind: "empty" }
  | { kind: "failed"; reason: string };

function libraryLink(id: string): string {
  return `${publicBaseUrl()}/library/${id}`;
}

function libraryRootLink(): string {
  return `${publicBaseUrl()}/library`;
}

function libraryQueryLink(query: string): string {
  return `${publicBaseUrl()}/library?q=${encodeURIComponent(query)}`;
}

/** One hit line: `编号 · 标题(链接) · 类型 · 场景`. The title itself links to the card's library page (an HTML anchor, not a visible raw URL) so the internal id is never shown as text. Every card-derived value is escaped. */
function renderHit(item: CapabilityRow, scenarioLabel: Map<string, string>): string {
  const serial = displaySerial(item.verdict, item.type, item.serial);
  const scenarioNames = item.scenarios.map((slug) => scenarioLabel.get(slug) ?? slug).map(escapeHtml).join("、") || "无";
  const titleLink = `<a href="${escapeHtml(libraryLink(item.id))}">${escapeHtml(item.title)}</a>`;
  const parts = [
    serial ? escapeHtml(serial) : "-",
    titleLink,
    escapeHtml(typeLabel(item.type, "zh")),
    scenarioNames
  ];
  return parts.join(" · ");
}

/**
 * Searches the library from Telegram, reusing the exact web hybrid-search path (`parseSerialQuery`
 * → `matchScenarios`/`embedSearchQuery` → `listLibrary`) rather than a second implementation. A
 * serial-shaped query (`SKL-0007`, `#12`) resolves through the same `listLibrary` serial branch, so
 * it naturally comes back as a single hit; everything else is scored hybrid search, top
 * {@link SEARCH_RESULT_LIMIT}. Replies exactly once and never throws — this runs in the worker's
 * poll loop.
 */
export async function handleSearch(deps: SearchDeps, params: SearchParams): Promise<SearchOutcome> {
  const query = params.query.trim();
  try {
    const scenarios = await loadScenarios(deps.pool);
    const isSerialQuery = parseSerialQuery(query) !== null;
    const matchedScenarioSlugs = isSerialQuery ? [] : matchScenarios(query, scenarios);
    // embedSearchQuery never throws (degrades to null on a missing key, a failed call or a
    // timeout) — listLibrary then falls back to full-text/scenario/substring matching alone,
    // exactly like the web does.
    const queryEmbedding = isSerialQuery ? null : await embedSearchQuery(deps.config.providers.geminiApiKey, query);

    const filter: LibraryFilter = { q: query, page: 1 };
    const { items, total } = await listLibrary(deps.pool, filter, { queryEmbedding, matchedScenarioSlugs });

    if (items.length === 0) {
      await deps.api.sendMessage({
        chatId: params.chatId,
        text: `${NO_RESULTS_TEXT}\n${escapeHtml(libraryRootLink())}`,
        replyToMessageId: params.messageId
      });
      return { kind: "empty" };
    }

    const scenarioLabel = new Map(scenarios.map((s) => [s.slug, s.labelZh]));
    const shown = items.slice(0, SEARCH_RESULT_LIMIT);
    const lines = shown.map((item) => renderHit(item, scenarioLabel));
    if (total > shown.length) {
      lines.push(`还有更多结果，去 web 看看：${escapeHtml(libraryQueryLink(query))}`);
    }

    await deps.api.sendMessage({ chatId: params.chatId, text: lines.join("\n"), replyToMessageId: params.messageId });
    return { kind: "results", total, shown: shown.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: "telegram search failed", chatId: params.chatId, error: message }));
    try {
      await deps.api.sendMessage({ chatId: params.chatId, text: "搜索出错了，请稍后重试", replyToMessageId: params.messageId });
    } catch (sendError) {
      void sendError;
    }
    return { kind: "failed", reason: message };
  }
}
