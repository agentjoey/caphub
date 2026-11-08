import type { CapabilityType } from "../../lib/analysis/card";
import type { CapabilityRow } from "../../lib/library/queries";
import type { RecentCapture } from "../../lib/captures/captures";
import { displaySerial } from "../../lib/library/serial";
export type DeskItem =
  | {
      kind: "running";
      captureId: string;
      createdAt: string;
      captureKind: "image" | "text" | "url";
      url: string | null;
      okSteps: string[];
      preview: string | null;
    }
  | {
      kind: "failed";
      captureId: string;
      createdAt: string;
      captureKind: "image" | "text" | "url";
      errorCode: string | null;
      preview: string | null;
    }
  | {
      kind: "pending";
      id: string;
      captureId: string;
      updatedAt: string;
      createdAt: string;
      title: string;
      type: CapabilityType;
      summary: string;
      summaryPoints: Array<{
        label: string;
        text: string;
      }>;
      tags: string[];
      usage: "integrate" | "reference";
      score: number | null;
      suggestedVerdict: "keep" | "discard";
      suggestedReason: string;
      confidence: number;
    };
export type PileItem = {
  id: string;
  captureId: string;
  serial: string | null;
  title: string;
  type: CapabilityType;
  summary: string;
  usage: "integrate" | "reference";
  score: number | null;
};
export const deskKey = (item: DeskItem) => (item.kind === "pending" ? item.id : item.captureId);
export function assembleDeskItems(
  running: RecentCapture[],
  recent: RecentCapture[],
  pending: CapabilityRow[],
  limit = 24
): DeskItem[] {
  const items: DeskItem[] = [];
  const seen = new Set<string>();
  for (const row of running) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({
      kind: "running",
      captureId: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      captureKind: row.kind,
      url: row.url,
      okSteps: row.okSteps,
      preview: row.text ?? row.url
    });
  }
  for (const row of recent) {
    if (row.runState !== "failed" || row.capabilityId || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({
      kind: "failed",
      captureId: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      captureKind: row.kind,
      errorCode: row.errorCode,
      preview: row.text ?? row.url
    });
  }
  for (const row of pending) {
    if (seen.has(row.captureId)) continue;
    seen.add(row.captureId);
    const {
      id,
      captureId,
      updatedAt,
      createdAt,
      title,
      type,
      summary,
      summaryPoints,
      tags,
      usage,
      score,
      suggestedVerdict,
      suggestedReason,
      confidence
    } = row;
    items.push({
      kind: "pending",
      id,
      captureId,
      updatedAt,
      createdAt,
      title,
      type,
      summary,
      summaryPoints,
      tags,
      usage,
      score,
      suggestedVerdict,
      suggestedReason,
      confidence
    });
  }
  return items.slice(0, limit);
}
export function pileItems(rows: CapabilityRow[]): PileItem[] {
  return rows.map((row) => ({
    id: row.id,
    captureId: row.captureId,
    serial: displaySerial(row.verdict, row.type, row.serial),
    title: row.title,
    type: row.type,
    summary: row.summary,
    usage: row.usage,
    score: row.score
  }));
}
export type DeskChange =
  | {
      kind: "spawn" | "update" | "promote";
      key: string;
      item: DeskItem;
    }
  | {
      kind: "file" | "trash";
      key: string;
    };
export function diffDeskItems(previous: DeskItem[], next: DeskItem[], pile: PileItem[]): DeskChange[] {
  const changes: DeskChange[] = [];
  const used = new Set<string>();
  for (const item of next) {
    const old =
      previous.find((p) => deskKey(p) === deskKey(item)) ??
      previous.find((p) => p.captureId === item.captureId);
    if (old) used.add(deskKey(old));
    changes.push({
      kind: !old ? "spawn" : old.kind !== item.kind ? "promote" : "update",
      key: old ? deskKey(old) : deskKey(item),
      item
    });
  }
  for (const item of previous)
    if (!used.has(deskKey(item)))
      changes.push({
        kind: pile.some((p) => p.captureId === item.captureId) ? "file" : "trash",
        key: deskKey(item)
      });
  return changes;
}
