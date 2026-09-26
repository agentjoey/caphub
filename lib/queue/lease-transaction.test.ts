import { describe, expect, it } from "vitest";
import { withLeaseTransaction, type Lease } from "./runs";

// These fake-client checks verify application SQL/transaction ordering; they do not exercise
// PostgreSQL's actual row-lock waiting, lease clock, or competing-claim behavior.
const lease: Lease = {
  runId: "run_lease_test",
  captureId: "cap_lease_test",
  pipeline: "mixed",
  ownerToken: "owner_lease_test"
};

interface FakeOptions {
  lockFound?: boolean;
  leaseActive?: boolean[];
  onConnect?: () => void | Promise<void>;
  onQuery?: (sql: string) => void | Promise<void>;
  afterLeaseCheck?: (index: number) => void | Promise<void>;
}

function fakePool(options: FakeOptions = {}) {
  const events: string[] = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let connectCount = 0;
  let releaseCount = 0;
  let leaseCheckCount = 0;

  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        events.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE")) {
        events.push("LOCK");
        await options.onQuery?.(sql);
        return { rows: options.lockFound === false ? [] : [{ id: lease.runId }], rowCount: 1 };
      }
      if (sql.includes("clock_timestamp()")) {
        events.push("LEASE_CHECK");
        await options.onQuery?.(sql);
        const index = leaseCheckCount++;
        const leaseActive = options.leaseActive?.[index] ?? true;
        await options.afterLeaseCheck?.(index);
        return { rows: [{ lease_active: leaseActive }], rowCount: 1 };
      }
      events.push("OTHER_QUERY");
      await options.onQuery?.(sql);
      return { rows: [], rowCount: 1 };
    },
    release() {
      releaseCount += 1;
      events.push("RELEASE");
    }
  };

  const pool = {
    async connect() {
      connectCount += 1;
      await options.onConnect?.();
      events.push("CONNECT");
      return client;
    }
  };

  return { pool: pool as never, events, queries, get connectCount() { return connectCount; }, get releaseCount() { return releaseCount; } };
}

function abortError() {
  return expect.objectContaining({ code: "ABORTED" });
}

describe("withLeaseTransaction", () => {
  it("does not connect when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = fakePool();

    await expect(withLeaseTransaction(harness.pool, lease, controller.signal, async () => "written"))
      .rejects.toMatchObject(abortError());

    expect(harness.connectCount).toBe(0);
    expect(harness.queries).toEqual([]);
    expect(harness.releaseCount).toBe(0);
  });

  it("does not write after connect when cancellation arrives before BEGIN", async () => {
    const controller = new AbortController();
    const harness = fakePool({ onConnect: () => controller.abort() });
    const write = async () => "written";

    await expect(withLeaseTransaction(harness.pool, lease, controller.signal, write))
      .rejects.toMatchObject(abortError());

    expect(harness.events).toEqual(["CONNECT", "RELEASE"]);
    expect(harness.queries).toEqual([]);
    expect(harness.releaseCount).toBe(1);
  });

  it("does not write when cancellation arrives while waiting for the lease row lock", async () => {
    const controller = new AbortController();
    const harness = fakePool({ onQuery: (sql) => { if (sql.includes("FOR UPDATE")) controller.abort(); } });
    let writes = 0;

    await expect(withLeaseTransaction(harness.pool, lease, controller.signal, async () => { writes += 1; }))
      .rejects.toMatchObject(abortError());

    expect(writes).toBe(0);
    expect(harness.events).toContain("ROLLBACK");
    expect(harness.events).not.toContain("COMMIT");
    expect(harness.releaseCount).toBe(1);
  });

  it("does not write when the post-lock database lease check says the lease was lost", async () => {
    const harness = fakePool({ leaseActive: [false] });
    let writes = 0;

    await expect(withLeaseTransaction(harness.pool, lease, new AbortController().signal, async () => { writes += 1; }))
      .rejects.toMatchObject({ code: "LEASE_LOST" });

    expect(writes).toBe(0);
    expect(harness.events).toContain("ROLLBACK");
    expect(harness.events).not.toContain("COMMIT");
    expect(harness.releaseCount).toBe(1);
  });

  it("uses a separate clock_timestamp owner/state/expiry check after the row lock", async () => {
    const harness = fakePool({ leaseActive: [true, true] });
    const result = await withLeaseTransaction(harness.pool, lease, new AbortController().signal, async () => {
      harness.events.push("WRITE");
      return "saved";
    });

    const lock = harness.queries.find(({ sql }) => sql.includes("FOR UPDATE"))!;
    const checks = harness.queries.filter(({ sql }) => sql.includes("clock_timestamp()"));
    expect(result).toBe("saved");
    expect(lock.sql).toMatch(/SELECT id FROM caphub_v2\.analysis_runs WHERE id = \$1 FOR UPDATE/);
    expect(lock.sql).not.toContain("clock_timestamp()");
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.sql).toContain("state = 'running'");
      expect(check.sql).toContain("owner_token = $2");
      expect(check.sql).toContain("lease_until > clock_timestamp()");
      expect(check.values).toEqual([lease.runId, lease.ownerToken]);
    }
    expect(harness.events).toEqual([
      "CONNECT", "BEGIN", "LOCK", "LEASE_CHECK", "WRITE", "LEASE_CHECK", "COMMIT", "RELEASE"
    ]);
    expect(harness.releaseCount).toBe(1);
  });

  it("rolls back without committing when cancellation arrives after the write", async () => {
    const controller = new AbortController();
    const harness = fakePool({ leaseActive: [true] });

    await expect(withLeaseTransaction(harness.pool, lease, controller.signal, async () => {
      harness.events.push("WRITE");
      controller.abort();
    })).rejects.toMatchObject(abortError());

    expect(harness.events).toEqual(["CONNECT", "BEGIN", "LOCK", "LEASE_CHECK", "WRITE", "ROLLBACK", "RELEASE"]);
    expect(harness.events).not.toContain("COMMIT");
    expect(harness.releaseCount).toBe(1);
  });

  it("rolls back without committing when the lease expires after the write", async () => {
    const harness = fakePool({ leaseActive: [true, false] });

    await expect(withLeaseTransaction(harness.pool, lease, new AbortController().signal, async () => {
      harness.events.push("WRITE");
    })).rejects.toMatchObject({ code: "LEASE_LOST" });

    expect(harness.events).toEqual([
      "CONNECT", "BEGIN", "LOCK", "LEASE_CHECK", "WRITE", "LEASE_CHECK", "ROLLBACK", "RELEASE"
    ]);
    expect(harness.events).not.toContain("COMMIT");
    expect(harness.releaseCount).toBe(1);
  });

  it("rolls back if the write callback throws and releases the connection once", async () => {
    const harness = fakePool();
    const failure = new Error("business write failed");

    await expect(withLeaseTransaction(harness.pool, lease, new AbortController().signal, async () => {
      harness.events.push("WRITE");
      throw failure;
    })).rejects.toBe(failure);

    expect(harness.events).toEqual(["CONNECT", "BEGIN", "LOCK", "LEASE_CHECK", "WRITE", "ROLLBACK", "RELEASE"]);
    expect(harness.events).not.toContain("COMMIT");
    expect(harness.releaseCount).toBe(1);
  });
});
