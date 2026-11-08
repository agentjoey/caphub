import { expect, it, vi } from "vitest";
import { listLatestKept, listPendingForDesk } from "./queries";
import { listDeskRunning } from "../captures/captures";
it("latest kept excludes retired/deleted and orders by update, with a bound limit", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ updatedAt: new Date("2026-01-01") }] });
  const rows = await listLatestKept({ query } as never, 5);
  const [sql, args] = query.mock.calls[0];
  expect(sql).toContain("cb.verdict = 'keep'");
  expect(sql).toContain("cb.status = 'active'");
  expect(sql).toContain("cb.deleted_at IS NULL");
  expect(sql).toContain("ORDER BY cb.updated_at DESC");
  expect(args).toEqual([5]);
  expect(rows[0].updatedAt).toBe("2026-01-01T00:00:00.000Z");
});
it("pending desk accepts more than a review page and serializes dates", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ createdAt: new Date("2026-01-01") }] });
  const rows = await listPendingForDesk({ query } as never, 24);
  expect(query.mock.calls[0][0]).toContain("cb.verdict = 'pending'");
  expect(query.mock.calls[0][0]).toContain("cb.deleted_at IS NULL");
  expect(query.mock.calls[0][0]).toContain("ORDER BY cb.created_at DESC");
  expect(query.mock.calls[0][1]).toEqual([24]);
  expect(typeof rows[0].createdAt).toBe("string");
});
it("running uses latest analysis run without a recent-capture limit, excludes decided/deleted cards", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ createdAt: new Date("2026-01-01") }] });
  const rows = await listDeskRunning({ query } as never);
  const sql = query.mock.calls[0][0];
  expect(sql).toContain("kind = 'analysis'");
  expect(sql).toContain("ORDER BY created_at DESC LIMIT 1");
  expect(sql).toContain("r.state IN ('queued', 'running')");
  expect(sql).toContain("cb.verdict = 'pending'");
  expect(sql).toContain("cb.deleted_at IS NULL");
  expect(sql).toContain('"okSteps"');
  expect(sql).not.toContain("LIMIT $1");
  expect(typeof rows[0].createdAt).toBe("string");
});
