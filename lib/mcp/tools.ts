import type { Pool } from "pg";
import type { CapabilityType } from "../analysis/card";
import { loadScenarios } from "../analysis/scenarios";
import { setProgress } from "../library/actions";
import { appendBuildNote, normalizeNote } from "../library/build-notes";
import type { Progress } from "../library/labels";
import { embedSearchQuery } from "../library/query-embedding";
import { getCapabilityDetail, libraryStats, listLibrary, listTodoCapabilities, type CapabilityDetail, type CapabilityRow, type LibraryFilter } from "../library/queries";
import { matchScenarios } from "../library/scenario-match";
import { formatSerial, parseSerialQuery } from "../library/serial";
import { resolveSerial } from "./serial";

export { resolveSerial } from "./serial";

/** Public web base for a card's page link — never the internal id alone, and never a storage key. */
const WEB_BASE = "https://caphub.agentjoey.ai";

/** Hard cap on any list a read-only tool returns, regardless of what the caller asked for. */
export const MAX_ITEMS = 25;

const clamp = (n: unknown, fallback: number): number =>
  Math.min(MAX_ITEMS, Math.max(1, Number.isInteger(n) ? (n as number) : fallback));

export interface ToolDeps {
  pool: Pool;
  geminiApiKey?: string;
}

/** The card fields safe to hand to another agent: never a storage key, never image bytes. */
function toBrief(row: CapabilityRow) {
  return {
    serial: formatSerial(row.type, row.serial),
    title: row.title,
    type: row.type,
    usage: row.usage,
    score: row.score,
    tags: row.tags,
    summary: row.summary,
    summaryPoints: row.summaryPoints,
    url: `${WEB_BASE}/library/${row.id}`
  };
}

export interface SearchCapabilitiesInput {
  query: string;
  limit?: number;
  type?: CapabilityType;
  tags?: string[];
  usage?: "integrate" | "reference";
}

/**
 * Hybrid library search, reusing the exact same reuse chain as the web/Telegram search paths
 * (`parseSerialQuery` → `matchScenarios`/`embedSearchQuery` → `listLibrary`) — see
 * `lib/telegram/search.ts`'s `handleSearch` for the reference implementation. `embedSearchQuery`
 * never throws; on a missing key or a failed/timed-out call it returns null and `listLibrary`
 * falls back to full-text/scenario/substring matching alone.
 */
export async function searchCapabilities(deps: ToolDeps, input: SearchCapabilitiesInput) {
  const query = input.query.trim();
  const scenarios = await loadScenarios(deps.pool);
  const isSerial = parseSerialQuery(query) !== null;
  const matchedScenarioSlugs = isSerial ? [] : matchScenarios(query, scenarios);
  const queryEmbedding = isSerial ? null : await embedSearchQuery(deps.geminiApiKey, query);

  const filter: LibraryFilter = {
    q: query,
    page: 1,
    ...(input.type ? { types: [input.type] } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.usage ? { usage: input.usage } : {})
  };
  const { items, total } = await listLibrary(deps.pool, filter, { queryEmbedding, matchedScenarioSlugs });
  return { total, items: items.slice(0, clamp(input.limit, 10)).map(toBrief) };
}

export interface GetCapabilityInput {
  serial: string;
}

/**
 * Resolves a serial (`SKL-0031`, `#31`) to its card and returns the brief fields plus the deeper
 * detail an agent needs to actually use the capability. Returns null when the serial doesn't
 * resolve to a kept, active, non-deleted card — never partial data for a hidden card.
 */
export async function getCapability(deps: ToolDeps, input: GetCapabilityInput) {
  const resolved = await resolveSerial(deps.pool, input.serial);
  if (!resolved) return null;
  const detail = await getCapabilityDetail(deps.pool, resolved.id);
  if (!detail) return null;
  return toDetailOutput(detail);
}

function toDetailOutput(detail: CapabilityDetail) {
  return {
    ...toBrief(detail),
    signals: detail.signals,
    playbook: detail.playbook,
    sourceFacts: detail.sourceFacts,
    scenarios: detail.scenarios,
    openQuestions: detail.openQuestions,
    deepAnalysis: detail.deepAnalysis,
    progress: detail.progress,
    progressLink: detail.progressLink,
    buildNotes: detail.buildNotes
  };
}

export interface ListToBuildInput {
  limit?: number;
}

/** Kept, reference-only cards still awaiting/undergoing self-build (the `/todo` set). */
export async function listToBuild(deps: ToolDeps, input: ListToBuildInput = {}) {
  const { items, total } = await listTodoCapabilities(deps.pool, { page: 1 });
  return { total, items: items.slice(0, clamp(input.limit, 10)).map(toBrief) };
}

export interface ListRecentInput {
  limit?: number;
}

/** Most recently added kept, active cards. */
export async function listRecent(deps: ToolDeps, input: ListRecentInput = {}) {
  const { items, total } = await listLibrary(deps.pool, { page: 1 });
  return { total, items: items.slice(0, clamp(input.limit, 10)).map(toBrief) };
}

/** Library-wide counts (by type, tag count, pending, to-build) — plain numbers, always JSON-safe. */
export function getStats(deps: ToolDeps) {
  return libraryStats(deps.pool);
}

/** Self-build progress an agent may set — never `todo`/`planned`, which are the human's scheduling act. */
const AGENT_PROGRESS = ["building", "done", "dropped"] as const;

export interface SetBuildProgressInput {
  serial: string;
  progress: string;
  link?: string | null;
  note?: string;
  by?: string;
}

export type WriteToolResult =
  | { ok: true; serial: string; progress?: string; noteCount?: number; noteSkipped?: string }
  | { ok: false; error: string };

/**
 * The only way an agent can move a card's self-build progress. Refuses `todo`/`planned` outright
 * (those are the human's scheduling decision, not the agent's), then resolves the serial and
 * delegates to {@link setProgress}. When a `note` is also given, it is appended in a *second*
 * write — the ruling for this task is that these are two statements, not one transaction — and
 * critically uses the `updatedAt` `setProgress` just returned as the note's optimistic-lock
 * token, not the one read before the progress write, since `setProgress` already bumped
 * `updated_at` and the stale value would make the note's own lock check fail every time.
 */
export async function setBuildProgress(deps: ToolDeps, input: SetBuildProgressInput): Promise<WriteToolResult> {
  if (!(AGENT_PROGRESS as readonly string[]).includes(input.progress)) {
    return { ok: false, error: "progress 只能是 building / done / dropped；排期（todo / planned）由人来定" };
  }
  const card = await resolveSerial(deps.pool, input.serial);
  if (!card) return { ok: false, error: `找不到编号 ${input.serial}` };
  const r = await setProgress(deps.pool, { id: card.id, expectedUpdatedAt: card.updatedAt, progress: input.progress as Progress, link: input.link ?? null });
  if (!r.ok) return { ok: false, error: r.message };
  if (!input.note) return { ok: true, serial: input.serial, progress: input.progress };
  const note = normalizeNote({ by: input.by, text: input.note });
  if (!note) return { ok: true, serial: input.serial, progress: input.progress, noteSkipped: "笔记为空或超过 2000 字" };
  const n = await appendBuildNote(deps.pool, { id: card.id, expectedUpdatedAt: r.updatedAt, note });
  return n.ok
    ? { ok: true, serial: input.serial, progress: input.progress, noteCount: 1 }
    : { ok: false, error: n.message };
}

export interface AppendNoteInput {
  serial: string;
  note: string;
  by?: string;
}

/** Appends a self-build note without touching progress — resolveSerial -> normalizeNote -> appendBuildNote. */
export async function appendNote(deps: ToolDeps, input: AppendNoteInput): Promise<WriteToolResult> {
  const card = await resolveSerial(deps.pool, input.serial);
  if (!card) return { ok: false, error: `找不到编号 ${input.serial}` };
  const note = normalizeNote({ by: input.by, text: input.note });
  if (!note) return { ok: false, error: "笔记为空或超过 2000 字" };
  const n = await appendBuildNote(deps.pool, { id: card.id, expectedUpdatedAt: card.updatedAt, note });
  return n.ok ? { ok: true, serial: input.serial, noteCount: 1 } : { ok: false, error: n.message };
}
