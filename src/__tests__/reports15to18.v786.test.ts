// BF_SERVER_REPORTS15_18_v786
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootIndex } from "./helpers/bootIndex.js";

const sqls: string[] = [];
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 0 }; } } }));
import { customReport, CUSTOM } from "../services/reports/data8.js";
import { DATA } from "../services/reports/data.js";
import { reportByKey } from "../services/reports/catalog.js";

describe("reports 15-18", () => {
  it("are registered", () => {
    for (const k of ["pipeline_snapshot", "issues_report", "custom_report"]) expect(typeof (DATA as any)[k], k).toBe("function");
    expect(reportByKey("bi_insurance")).toMatchObject({ silo: "BI", source: "portal" }); // drawn by the portal from BI-Server
  });
  it("the custom builder only runs groupings and measures from its fixed menu", async () => {
    const bad = await customReport({ entity: "applications", groupBy: "id; DROP TABLE applications", measure: "count" });
    expect(bad.error).toBe("unknown_grouping_or_measure");
    expect(sqls.length).toBe(0);
    const unknown = await customReport({ entity: "users" });
    expect(unknown.error).toBe("unknown_record_type");
    await customReport({ entity: "tasks", groupBy: "assignee", measure: "overdue", days: 30 });
    expect(sqls[0]).toContain(CUSTOM.tasks!.measures.overdue);
    expect(sqls[0]).toContain("t.deleted_at IS NULL");
  });
  it("snapshots are taken hourly by a background worker that starts in the staggered sequence", async () => {
    const boot = await bootIndex({ env: { WORKER_STAGGER_MS: "1500" } });
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startPipelineSnapshotWorker")).toEqual([[boot.pool]]);
      const ev = boot.events;
      const at = ev.indexOf("start:startPipelineSnapshotWorker");
      expect(at).toBeGreaterThan(ev.indexOf("listen")); // background, after the server is up
      const prev = ev.slice(0, at).map((e, i) => (e.startsWith("start:") ? i : -1)).filter((i) => i >= 0).pop()!;
      expect(ev.slice(prev, at)).toContain("timeout:1500"); // paused before it like every other worker
    } finally { boot.restore(); }
    expect(readFileSync("migrations/2026_10_08_v786_pipeline_snapshots.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS pipeline_snapshots");
  });
});
