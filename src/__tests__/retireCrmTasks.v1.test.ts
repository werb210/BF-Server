// BF_SERVER_RETIRE_CRM_TASKS_v1 - the legacy crm_tasks backend is retired: the
// old /api/crm/contacts|companies/:id/tasks routes are removed, the timeline
// reads the unified `tasks` table only, and a migration copies existing
// crm_tasks rows into `tasks` so nothing is lost.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_06_retire_crm_tasks.sql"), "utf-8");
const ID = "c0c0c0c0-0000-4000-8000-0000000000aa";

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("crm_tasks retired from the app", () => {
  it("timeline no longer reads crm_tasks; reads unified tasks only", async () => {
    const { loadCrmTimeline } = await import("../routes/crm/timeline.js");
    for (const isContact of [true, false]) {
      queryMock.mockClear();
      await loadCrmTimeline(isContact, ID, "BF");
      const col = isContact ? "contact_id" : "company_id";
      const sql = String(queryMock.mock.calls[0][0]);
      expect(sql).not.toMatch(/FROM crm_tasks\b/);
      expect(sql).toContain(`FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL`);
    }
  });
  it("legacy crm tasks routes are removed", async () => {
    const app = mountRouter((await import("../routes/crm.js")).default, "/api/crm");
    const auth = { Authorization: `Bearer ${staffToken()}` };
    for (const base of ["contacts", "companies"]) {
      expect((await request(app).get(`/api/crm/${base}/${ID}/tasks`).set(auth)).status).toBe(404);
      expect((await request(app).post(`/api/crm/${base}/${ID}/tasks`).set(auth).send({ title: "t" })).status).toBe(404);
    }
    expect(callsMatching(queryMock, /\bcrm_tasks\b/)).toHaveLength(0);
  });
  it("route manifest no longer advertises the crm tasks endpoints", async () => {
    const { ROUTES } = await import("../routes/routeRegistry.js");
    const paths = ROUTES.map((r) => r.path);
    expect(paths).not.toContain("/api/crm/contacts/:id/tasks");
    expect(paths).not.toContain("/api/crm/companies/:id/tasks");
  }, 60_000); // the registry imports every router
  it("the crm/tasks router module is deleted", async () => {
    const legacy = "../routes/crm/" + "tasks.js";
    await expect(import(/* @vite-ignore */ legacy)).rejects.toThrow();
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

// BF_SERVER_v789_TASKS_UNIFIED - crm_tasks is retired everywhere: no file under src (outside
// migrations and tests) may reference it in code. Comments that mention the retirement are
// fine; they are stripped before the check.
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "tests" || name === "migrations") continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1").replace(/(^|\s)--\s.*$/, "$1"))
    .join("\n");
}

describe("no crm_tasks reference anywhere in src", () => {
  it("strips comments but still sees code references", () => {
    expect(/\bcrm_tasks\b/.test(stripComments("// crm_tasks is retired\n  -- not crm_tasks\n/* crm_tasks */"))).toBe(false);
    expect(/\bcrm_tasks\b/.test(stripComments("pool.query(`SELECT 1 FROM crm_tasks t`) // ok"))).toBe(true);
    expect(/\bcrm_tasks\b/.test(stripComments("const u = \"https://x\"; q(\"INSERT INTO crm_tasks\")"))).toBe(true);
  });

  it("v789 migration copies late crm_tasks rows, guarded so it runs without the table", () => {
    const v789 = readFileSync(join(process.cwd(), "migrations", "2026_10_12_v789_audit2.sql"), "utf-8");
    expect(v789).toContain("to_regclass('public.crm_tasks') IS NOT NULL");
    expect(v789).toContain("EXECUTE $sql$");
    expect(v789).toContain("t.source = 'IMPORT' AND t.source_ref_id = ct.id");
  });

  it("finds no crm_tasks in src outside migrations and tests", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src"))
      .filter((f) => /\bcrm_tasks\b/.test(stripComments(readFileSync(f, "utf-8"))))
      .map((f) => f.slice(process.cwd().length + 1));
    expect(offenders).toEqual([]);
  });
});
