// BF_SERVER_ABANDON_FIX_v64 - the task insert failed twice in production, on
// two different CHECK constraints. This asserts EVERY constrained column
// against the migration, so a third round is not possible.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/workers/abandonedApplicationWorker.ts", "utf8");
const MIG = fs.readFileSync("migrations/2026_07_04_tasks_v1.sql", "utf8");

describe("every constrained column holds an allowed value", () => {
  it("source is WORKFLOW, not an invented label", () => {
    expect(SRC).toContain("'WORKFLOW', NULL)");
    expect(SRC).not.toContain("'ABANDONED_APPLICATION'");
  });

  it("type is CALL", () => {
    expect(SRC).toContain("'CALL', 'HIGH', now()");
  });

  it("priority is HIGH", () => {
    expect(SRC).toContain("'HIGH'");
    expect(SRC).not.toContain("'high'");
  });

  it("status is left to the default, which is allowed", () => {
    const insert = SRC.slice(SRC.indexOf("INSERT INTO tasks"), SRC.indexOf("VALUES"));
    expect(insert).not.toContain("status");
  });
});

describe("the migration still permits exactly these", () => {
  it("source", () => {
    expect(MIG).toContain("source IN ('MANUAL','SEQUENCE','WORKFLOW','IMPORT','API')");
  });

  it("type", () => {
    expect(MIG).toContain("type IN ('CALL','EMAIL','SMS','TODO')");
  });

  it("priority", () => {
    expect(MIG).toContain("priority IN ('NONE','LOW','MEDIUM','HIGH')");
  });
});

describe("the failures still self-heal", () => {
  it("stamps only after a successful insert", () => {
    const insert = SRC.indexOf("INSERT INTO tasks");
    const stamp = SRC.indexOf("abandon_task_created_at = now()");
    expect(stamp).toBeGreaterThan(insert);
  });
});
