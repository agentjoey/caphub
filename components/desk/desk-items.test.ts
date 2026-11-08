import { expect, it } from "vitest";
import { assembleDeskItems, diffDeskItems, deskKey, type DeskItem } from "./desk-items";
import type { RecentCapture } from "../../lib/captures/captures";
import type { CapabilityRow } from "../../lib/library/queries";
const running = {
  id: "capture",
  kind: "text",
  createdAt: "2026-01-01",
  runState: "running",
  okSteps: [],
  capabilityId: null
} as unknown as RecentCapture;
const card = {
  id: "card",
  captureId: "capture",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  title: "Test",
  summaryPoints: [],
  tags: []
} as unknown as CapabilityRow;
it("prioritizes running, then uncarded failures, then pending; deduplicates before limiting", () => {
  const items = assembleDeskItems(
    [running],
    [
      { ...running, id: "failed", runState: "failed" },
      { ...running, id: "has-card", runState: "failed", capabilityId: "old" }
    ],
    [card, { ...card, id: "other", captureId: "other" }],
    3
  );
  expect(items.map((x) => x.kind)).toEqual(["running", "failed", "pending"]);
  expect(items.map(deskKey)).toEqual(["capture", "failed", "other"]);
  expect(assembleDeskItems([running], [], [card], 1)).toHaveLength(1);
});
it("promotes in place by captureId, updates stable keys, files only captures in the new pile", () => {
  const before = assembleDeskItems([running], [], []);
  const after = assembleDeskItems([], [], [card]);
  expect(diffDeskItems(before, after, [])).toEqual([{ kind: "promote", key: "capture", item: after[0] }]);
  expect(diffDeskItems(after, after, [])[0].kind).toBe("update");
  expect(diffDeskItems(before, [], [{ captureId: "capture" } as never])[0].kind).toBe("file");
  expect(diffDeskItems(before, [], [])[0].kind).toBe("trash");
  expect(diffDeskItems([], after, [])[0].kind).toBe("spawn");
  expect(diffDeskItems(before, [{ ...before[0], preview: "new" } as DeskItem], [])[0].kind).toBe("update");
});
