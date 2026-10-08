// BF_SERVER_REPORTS15_18_v786
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  it("snapshots are taken hourly by a background worker that starts in the staggered sequence", () => {
    const s = readFileSync("src/index.ts", "utf8");
    expect(s).toContain("startPipelineSnapshotWorker(pool)");
    expect(s.indexOf("startPipelineSnapshotWorker(pool)")).toBeGreaterThan(s.indexOf("void (async () => {"));
    expect(readFileSync("migrations/2026_10_08_v786_pipeline_snapshots.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS pipeline_snapshots");
  });
});
