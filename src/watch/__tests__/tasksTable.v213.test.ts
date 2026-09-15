// BF_SERVER_TASKS_TABLE_FIX_v213
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snap = readFileSync("src/watch/snapshotRoutes.ts", "utf-8");
const watchRoutes = readFileSync("src/watch/dataRoutes.ts", "utf-8");
const migration = readFileSync("migrations/2026_09_15_v213_tasks_source_call_disposition.sql", "utf-8");

function tasksSchema(): string {
  const dir = "migrations";
  for (const f of readdirSync(dir)) {
    const sql = readFileSync(`${dir}/${f}`, "utf-8");
    if (sql.includes("CREATE TABLE IF NOT EXISTS tasks (")) return sql;
  }
  throw new Error("tasks table definition not found");
}

describe("the snapshot counts the live table", () => {
  it("no longer reads the retired crm_tasks", () => {
    expect(snap).not.toContain("FROM crm_tasks");
    expect(snap).toContain("FROM tasks");
  });

  it("uses the column tasks actually has", () => {
    const schema = tasksSchema();
    expect(schema).toContain("assignee_user_id");
    expect(snap).toContain("assignee_user_id = $1::uuid");
    // assigned_to / owner_id are crm_tasks columns and do not exist here.
    expect(snap).not.toContain("assigned_to");
    expect(snap).not.toContain("owner_id");
  });

  it("uses status values the CHECK constraint permits", () => {
    const schema = tasksSchema();
    for (const status of ["COMPLETED", "DEFERRED"]) {
      expect(schema).toContain(`'${status}'`);
      expect(snap).toContain(`'${status}'`);
    }
    expect(snap).not.toContain("lower(COALESCE(status");
  });

  it("still includes overdue tasks", () => {
    expect(snap).toContain("due_at < date_trunc('day', now()) + interval '1 day'");
  });
});

describe("the follow-up task that never inserted", () => {
  it("writes a source the constraint now allows", () => {
    expect(watchRoutes).toContain("'CALL_DISPOSITION'");
    expect(migration).toContain("'CALL_DISPOSITION'");
  });

  it("keeps every source value that was already permitted", () => {
    for (const s of ["MANUAL", "SEQUENCE", "WORKFLOW", "IMPORT", "API"]) {
      expect(migration).toContain(`'${s}'`);
    }
  });

  it("replaces the constraint rather than dropping the check entirely", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS tasks_source_check");
    expect(migration).toContain("ADD CONSTRAINT tasks_source_check");
  });

  it("indexes the lookup the watch snapshot now makes every refresh", () => {
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS tasks_assignee_due_open_idx");
  });
});
