// BF_SERVER_ABANDON_FIX_v62 - v61 shipped with priority 'high' and every task
// insert failed the CHECK constraint in production.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/workers/abandonedApplicationWorker.ts", "utf8");
const MIG = fs.readFileSync("migrations/2026_07_04_tasks_v1.sql", "utf8");

describe("the task insert satisfies its constraints", () => {
  it("uses an allowed priority", () => {
    expect(SRC).toContain("'CALL', 'HIGH', now()");
    expect(SRC).not.toContain("'high'");
  });

  it("uses an allowed type", () => {
    expect(SRC).toContain("'CALL'");
  });

  it("matches what the schema actually permits", () => {
    expect(MIG).toContain("priority IN ('NONE','LOW','MEDIUM','HIGH')");
    expect(MIG).toContain("type IN ('CALL','EMAIL','SMS','TODO')");
  });
});

describe("the failures self-heal", () => {
  it("only stamps after a successful insert, so every row retries", () => {
    const insert = SRC.indexOf("INSERT INTO tasks");
    const stamp = SRC.indexOf("abandon_task_created_at = now()");
    expect(stamp).toBeGreaterThan(insert);
  });
});
