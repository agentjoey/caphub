import { describe, expect, it } from "vitest";
import { planMigrations } from "./migrate";

describe("planMigrations", () => {
  it("returns only files not yet applied, sorted", () => {
    const plan = planMigrations(["002_b.sql", "001_a.sql", "003_c.sql"], new Set(["001_a.sql"]));
    expect(plan).toEqual(["002_b.sql", "003_c.sql"]);
  });
  it("rejects files without numeric prefix", () => {
    expect(() => planMigrations(["x.sql"], new Set())).toThrow(/migration name/);
  });
});
