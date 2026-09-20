import type { CapabilityType } from "../analysis/card";
import { loadScenarios } from "../analysis/scenarios";
import { recordTelegramReceipt } from "../captures/captures";
import { typeLabel } from "../library/labels";
import { listPending, listTodoCapabilities, libraryStats, TODO_PROGRESS, type CapabilityRow, type TodoCapabilityRow } from "../library/queries";
import { escapeHtml, type BotCommand, type TelegramApi } from "./api";
import { publicBaseUrl } from "./capture";
import { formatResult, type DecidedCardInput, type TodoCardInput } from "./format";
import { handleSearch, type SearchDeps, type SearchOutcome } from "./search";

/** At most this many pending cards are pushed as individual messages; the rest get a web link. */
export const PENDING_SHOW_LIMIT = 5;
/** At most this many `/todo` cards are pushed as individual messages; the rest get a web link. */
export const TODO_SHOW_LIMIT = 5;

const TYPES: CapabilityType[] = ["skill", "experience", "plugin", "prompt", "tool", "model", "other"];

const HELP_TEXT = [
  "Caphub 使用说明",
  "· 发图 = 投递",
  "· 发链接 = 投递",
  "· /add 文字 = 投递（也可以回复一条消息发送 /add 投递）",
  "· 直接打字 = 搜索",
  "· 待处理卡片下方的按钮可以直接保留 / 丢弃 / 重跑分析",
  "· 已保留卡片下方的 🔬 深度分析 会深挖这张卡，完成后推送摘要，全文在 web 看"
].join("\n");

const ADD_USAGE_TEXT = "用法：/add <文字>，或回复一条消息发送 /add 投递";
const FIND_USAGE_TEXT = "用法：/find <关键词>，直接打字也可以搜索";
const NO_PENDING_TEXT = "目前没有待处理的卡片";
const NO_TODO_TEXT = "目前没有待自研的卡片";
const UNKNOWN_COMMAND_TEXT = "不认识这个命令，发送 /help 看看能做什么";
const GENERIC_ERROR_TEXT = "出了点问题，请稍后重试";

/** The six slash commands the bot registers with Telegram (`setMyCommands`). */
export const COMMANDS: BotCommand[] = [
  { command: "help", description: "查看使用说明" },
  { command: "find", description: "搜索能力库" },
  { command: "add", description: "投递一段文字" },
  { command: "pending", description: "查看待处理卡片" },
  { command: "stats", description: "查看统计信息" },
  { command: "todo", description: "查看待自研卡片" }
];

export type CommandDeps = SearchDeps;

export interface CommandParams {
  chatId: number;
  messageId: number;
  name: string;
  arg: string;
}

export type CommandOutcome =
  | { kind: "help" }
  | { kind: "search"; result: SearchOutcome }
  | { kind: "find-usage" }
  | { kind: "add-usage" }
  | { kind: "pending"; shown: number; total: number }
  | { kind: "todo"; shown: number; total: number }
  | { kind: "stats" }
  | { kind: "unknown"; name: string }
  | { kind: "failed"; command: string; reason: string };

function libraryReviewLink(): string {
  return `${publicBaseUrl()}/review`;
}

/** The `/library` filter matching `listTodoCapabilities` (usage=reference, progress in {@link TODO_PROGRESS}), for `/todo`'s "more remain" line. */
function libraryTodoLink(): string {
  const progress = TODO_PROGRESS.map((p) => `progress=${p}`).join("&");
  return `${publicBaseUrl()}/library?usage=reference&${progress}`;
}

function toDecidedCardInput(row: CapabilityRow, scenarioLabel: Map<string, string>): DecidedCardInput {
  return {
    status: "pending",
    id: row.id,
    title: row.title,
    type: row.type,
    usage: row.usage,
    suggestedVerdict: row.suggestedVerdict,
    suggestedReason: row.suggestedReason,
    summary: row.summary,
    summaryPoints: row.summaryPoints,
    tags: row.tags,
    scenarioLabels: row.scenarios.map((slug) => scenarioLabel.get(slug) ?? slug),
    serial: row.serial,
    score: row.score,
    scoreReason: row.scoreReason,
    deepAnalyzed: row.hasDeepAnalysis,
    updatedAt: row.updatedAt
  };
}

/**
 * A `/todo` row always renders as a self-build card — never as the 「分析失败」 card — even when
 * the capture's latest analysis run failed: `/todo`'s job is to list self-build candidates, and
 * dropping the 进度 line and the progress buttons would leave the owner nothing to act on. A
 * failed latest run only adds a muted note (see format.ts's `formatTodo`).
 */
function toTodoCardInput(row: TodoCapabilityRow, scenarioLabel: Map<string, string>): TodoCardInput {
  return {
    status: "todo",
    lastRunError: row.lastRunState === "failed" ? row.lastRunErrorCode : undefined,
    id: row.id,
    title: row.title,
    type: row.type,
    summary: row.summary,
    summaryPoints: row.summaryPoints,
    tags: row.tags,
    scenarioLabels: row.scenarios.map((slug) => scenarioLabel.get(slug) ?? slug),
    serial: row.serial,
    score: row.score,
    scoreReason: row.scoreReason,
    progress: row.progress,
    deepAnalyzed: row.hasDeepAnalysis,
    updatedAt: row.updatedAt
  };
}

/** Best-effort reply; a failed send here must not throw out of the command handler. */
async function reply(deps: CommandDeps, chatId: number, text: string, replyToMessageId?: number): Promise<void> {
  try {
    await deps.api.sendMessage({ chatId, text, replyToMessageId });
  } catch (error) {
    console.error(JSON.stringify({ msg: "telegram command reply failed", chatId, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function handleHelp(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  await reply(deps, params.chatId, HELP_TEXT, params.messageId);
  return { kind: "help" };
}

async function handleFind(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  const query = params.arg.trim();
  if (query === "") {
    await reply(deps, params.chatId, FIND_USAGE_TEXT, params.messageId);
    return { kind: "find-usage" };
  }
  const result = await handleSearch(deps, { chatId: params.chatId, messageId: params.messageId, query });
  return { kind: "search", result };
}

async function handleAdd(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  // A non-empty argument (or a reply-to-message) is turned into a `text-capture` update by
  // router.ts's classifyUpdate *before* it ever reaches here — so reaching `handleAdd` at all
  // means there was nothing to submit. This only routes/validates; the actual capture path is
  // Task 3's handleCapture.
  await reply(deps, params.chatId, ADD_USAGE_TEXT, params.messageId);
  return { kind: "add-usage" };
}

/**
 * Renders up to {@link PENDING_SHOW_LIMIT} pending cards, each as its own Telegram message with
 * the same 保留/丢弃/重跑分析 buttons a push uses — via `formatResult`'s existing "pending"
 * rendering, never rebuilt here.
 */
async function handlePending(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  try {
    const { items, total } = await listPending(deps.pool, { page: 1 });
    if (items.length === 0) {
      await reply(deps, params.chatId, NO_PENDING_TEXT, params.messageId);
      return { kind: "pending", shown: 0, total: 0 };
    }

    const scenarios = await loadScenarios(deps.pool);
    const scenarioLabel = new Map(scenarios.map((s) => [s.slug, s.labelZh]));
    const shown = items.slice(0, PENDING_SHOW_LIMIT);

    for (const row of shown) {
      const rendered = formatResult(toDecidedCardInput(row, scenarioLabel));
      const sent = await deps.api.sendMessage({ chatId: params.chatId, text: rendered.text, replyMarkup: rendered.replyMarkup });
      // Regardless of the capture's source (telegram or web), record this message's ids on its
      // capture — this is how notify.ts's runNotifyTick later knows there is a Telegram message
      // to edit with the eventual (re)analysis result (see notify.ts's selectCandidates). A
      // failure here must not break the reply — the card was already sent.
      try {
        await recordTelegramReceipt(deps.pool, row.captureId, { chatId: params.chatId, messageId: sent.message_id });
      } catch (error) {
        console.error(JSON.stringify({
          msg: "telegram /pending record receipt failed", chatId: params.chatId, captureId: row.captureId,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    if (total > shown.length) {
      await deps.api.sendMessage({
        chatId: params.chatId,
        text: `还有更多待处理卡片，去 web 看看：${escapeHtml(libraryReviewLink())}`
      });
    }
    return { kind: "pending", shown: shown.length, total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: "telegram /pending failed", chatId: params.chatId, error: message }));
    await reply(deps, params.chatId, GENERIC_ERROR_TEXT, params.messageId);
    return { kind: "failed", command: "pending", reason: message };
  }
}

/**
 * Renders up to {@link TODO_SHOW_LIMIT} kept `usage='reference'` cards awaiting/undergoing
 * self-build, each as its own Telegram message with 🔨开始自研/✅已完成/🚫放弃/🔗去 web buttons —
 * via `formatResult`'s "todo" rendering (see format.ts's `formatTodo`), never rebuilt here.
 * Mirrors {@link handlePending} closely (including recording a Telegram receipt per card, so a
 * later button press's re-render — see decide.ts's `handleProgress` — edits this exact message).
 */
async function handleTodo(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  try {
    const { items, total } = await listTodoCapabilities(deps.pool, { page: 1 });
    if (items.length === 0) {
      await reply(deps, params.chatId, NO_TODO_TEXT, params.messageId);
      return { kind: "todo", shown: 0, total: 0 };
    }

    const scenarios = await loadScenarios(deps.pool);
    const scenarioLabel = new Map(scenarios.map((s) => [s.slug, s.labelZh]));
    const shown = items.slice(0, TODO_SHOW_LIMIT);

    for (const row of shown) {
      const rendered = formatResult(toTodoCardInput(row, scenarioLabel));
      const sent = await deps.api.sendMessage({ chatId: params.chatId, text: rendered.text, replyMarkup: rendered.replyMarkup });
      try {
        await recordTelegramReceipt(deps.pool, row.captureId, { chatId: params.chatId, messageId: sent.message_id });
      } catch (error) {
        console.error(JSON.stringify({
          msg: "telegram /todo record receipt failed", chatId: params.chatId, captureId: row.captureId,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    if (total > shown.length) {
      await deps.api.sendMessage({
        chatId: params.chatId,
        text: `还有更多待自研卡片，去 web 看看：${escapeHtml(libraryTodoLink())}`
      });
    }
    return { kind: "todo", shown: shown.length, total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: "telegram /todo failed", chatId: params.chatId, error: message }));
    await reply(deps, params.chatId, GENERIC_ERROR_TEXT, params.messageId);
    return { kind: "failed", command: "todo", reason: message };
  }
}

async function handleStats(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  try {
    const stats = await libraryStats(deps.pool);
    const lines = [
      "📊 统计",
      ...TYPES.map((type) => `${typeLabel(type, "zh")}：${stats.byType[type]}`),
      `标签数：${stats.tagCount}`,
      `待 Review：${stats.pending}`
    ];
    await reply(deps, params.chatId, lines.join("\n"), params.messageId);
    return { kind: "stats" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: "telegram /stats failed", chatId: params.chatId, error: message }));
    await reply(deps, params.chatId, GENERIC_ERROR_TEXT, params.messageId);
    return { kind: "failed", command: "stats", reason: message };
  }
}

/**
 * Dispatches a classified `{kind: "command"}` update (see router.ts). Every branch replies
 * exactly once and this never throws — it runs inside the worker's poll loop.
 */
export async function handleCommand(deps: CommandDeps, params: CommandParams): Promise<CommandOutcome> {
  const name = params.name.toLowerCase();
  try {
    switch (name) {
      case "help":
        return await handleHelp(deps, params);
      case "find":
        return await handleFind(deps, params);
      case "add":
        return await handleAdd(deps, params);
      case "pending":
        return await handlePending(deps, params);
      case "todo":
        return await handleTodo(deps, params);
      case "stats":
        return await handleStats(deps, params);
      default:
        await reply(deps, params.chatId, UNKNOWN_COMMAND_TEXT, params.messageId);
        return { kind: "unknown", name };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: "telegram command crashed", chatId: params.chatId, command: name, error: message }));
    await reply(deps, params.chatId, GENERIC_ERROR_TEXT, params.messageId);
    return { kind: "failed", command: name, reason: message };
  }
}

/** `setMyCommands` at worker startup. Failures only log — a stale command list is never fatal. */
export async function syncCommands(api: Pick<TelegramApi, "setMyCommands">): Promise<void> {
  try {
    await api.setMyCommands({ commands: COMMANDS });
  } catch (error) {
    console.error(JSON.stringify({ msg: "telegram setMyCommands failed", error: error instanceof Error ? error.message : String(error) }));
  }
}
