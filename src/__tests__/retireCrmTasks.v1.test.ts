// BF_SERVER_RETIRE_CRM_TASKS_v1 - the legacy crm_tasks backend is retired: the
// old /api/crm/contacts|companies/:id/tasks routes are removed, the timeline
// reads the unified `tasks` table only, and a migration copies existing
// crm_tasks rows into `tasks` so nothing is lost.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const timeline = readFileSync(join(process.cwd(), "src", "routes", "crm", "timeline.ts"), "utf-8");
const crm = readFileSync(join(process.cwd(), "src", "routes", "crm.ts"), "utf-8");
const registry = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf-8");
const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_06_retire_crm_tasks.sql"), "utf-8");

describe("crm_tasks retired from the app", () => {
  it("timeline no longer reads crm_tasks; reads unified tasks only", () => {
    expect(timeline).toContain("BF_SERVER_RETIRE_CRM_TASKS_v1");
    expect(timeline).not.toContain("FROM crm_tasks WHERE");
    expect(timeline).toContain("FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL");
  });
  it("legacy crm tasks routes + mount are removed", () => {
    expect(crm).not.toContain('router.use("/contacts/:id/tasks"');
    expect(crm).not.toContain('router.use("/companies/:id/tasks"');
    expect(crm).not.toContain('from "./crm/tasks.js"');
  });
  it("route manifest no longer advertises the crm tasks endpoints", () => {
    expect(registry).not.toContain("/api/crm/contacts/:id/tasks");
    expect(registry).not.toContain("/api/crm/companies/:id/tasks");
  });
  it("the crm/tasks.ts router file is deleted", () => {
    expect(existsSync(join(process.cwd(), "src", "routes", "crm", "tasks.ts"))).toBe(false);
  });
});

describe("crm_tasks data is preserved via migration", () => {
  it("migrates crm_tasks into the unified tasks table, idempotently", () => {
    expect(migration).toContain("INSERT INTO tasks");
    expect(migration).toContain("FROM crm_tasks ct");
    expect(migration).toContain("source_ref_id = ct.id");
    expect(migration).toContain("'IMPORT'");
  });
  it("skips rows that cannot satisfy assignee_user_id NOT NULL", () => {
    expect(migration).toContain("COALESCE(ct.assigned_to, ct.owner_id) IS NOT NULL");
  });
});
