// BF_SERVER_TIMELINE_UNIFIED_TASKS_v1 - tasks created via the HubSpot-style
// TaskPopup (which POSTs to /api/tasks -> the unified `tasks` table) must appear
// on the contact/company timeline. Previously the timeline only UNION'd the old
// crm_tasks table, so a task created from a BF or BI contact never showed up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const timeline = readFileSync(join(process.cwd(), "src", "routes", "crm", "timeline.ts"), "utf-8");

describe("CRM timeline includes unified tasks", () => {
  it("UNIONs the unified tasks table", () => {
    expect(timeline).toContain("BF_SERVER_TIMELINE_UNIFIED_TASKS_v1");
    expect(timeline).toContain("FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL");
  });
  it("adds the tasks branch to BOTH the contact and company query variants", () => {
    const branches = timeline.split("FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL").length - 1;
    expect(branches).toBe(2);
  });
  it("emits the task kind from the unified tasks branch (silo-scoped, no UI change)", () => {
    expect(timeline).toContain("SELECT 'task' AS kind, id::text, created_at AS ts,");
    // crm_tasks branch has been retired; timeline reads the unified tasks table only.
    expect(timeline).not.toContain("FROM crm_tasks WHERE ${col} = $1 AND silo = $2");
  });
});
