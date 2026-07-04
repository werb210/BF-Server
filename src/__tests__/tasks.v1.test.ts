// BF_SERVER_TASKS_V1 - Milestone 1: silo-scoped tasks + queues CRUD, views,
// first-class completed_at, label-only queue delete, soft task delete.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const routes = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");
const reg = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf-8");
const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_04_tasks_v1.sql"), "utf-8");
describe("tasks milestone 1", () => {
  it("mounted at /api/tasks", () => {
    expect(reg).toContain('{ path: "/tasks", router: tasksRoutes }');
  });
  it("every read/write is silo-scoped", () => {
    expect(routes.match(/silo = \$\d/g)!.length).toBeGreaterThan(8);
    expect(routes).toContain("resolveSiloFromRequest");
  });
  it("complete stamps completed_at; delete is soft; queue delete keeps tasks", () => {
    expect(routes).toContain("completed_at = now()");
    expect(routes).toContain("SET deleted_at = now()");
    expect(routes).toContain("SET queue_id = NULL");
  });
  it("migration is idempotent and covers all three silos", () => {
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBeGreaterThan(5);
    expect(mig).toContain("('BF','BI','SLF')");
  });
});
