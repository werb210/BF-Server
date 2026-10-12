// BF_SERVER_ABANDON_FIX_v64 - the task insert failed twice in production, on
// two different CHECK constraints. This checks EVERY constrained column the
// worker writes against the migration, so a third round is not possible.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import type { Pool } from "pg";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn(async () => undefined) }));
vi.mock("../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));

import { startAbandonedApplicationWorker } from "../workers/abandonedApplicationWorker.js";

const MIG = fs.readFileSync("migrations/2026_07_04_tasks_v1.sql", "utf8");

/** Allowed values of each CHECK (col IN (...)) constraint on the tasks table. */
function constraints(): Record<string, string[]> {
  const table = MIG.slice(MIG.indexOf("CREATE TABLE IF NOT EXISTS tasks"));
  const body = table.slice(0, table.indexOf(");\n"));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/\n\s*(\w+) text[^\n]*CHECK \((?:\1 IS NULL OR )?\1 IN \(([^)]*)\)\)/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
  }
  return out;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = "";
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth += 1;
    if (!quote && ch === ")") depth -= 1;
    if (!quote && depth === 0 && ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** column -> value the executed INSERT writes (a literal, or the bound parameter). */
function insertedRow(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = splitTop(sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")));
  const vals = splitTop(sql.slice(sql.indexOf("(", sql.indexOf("VALUES")) + 1, sql.lastIndexOf(")")));
  expect(vals).toHaveLength(cols.length);
  const row: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    const v = vals[i]!;
    const lit = v.match(/^'([^']*)'$/);
    const param = v.match(/^\$(\d+)$/);
    row[c] = lit ? lit[1] : param ? params[Number(param[1]) - 1] : v === "NULL" ? null : v;
  });
  return row;
}

async function inserted(silo: string | null = "BF") {
  const query = vi.fn(answerBySql([
    [/abandon_task_created_at IS NULL/, { rows: [{ id: "app-1", contact_id: "c-1", silo, phone: "+14035550100" }] }],
  ]));
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  const calls = callsMatching(query, "INSERT INTO tasks");
  expect(calls).toHaveLength(1);
  return { query, row: insertedRow(sqlText(calls[0]![0]), calls[0]![1] as unknown[]) };
}

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("every constrained column holds an allowed value", () => {
  it("source is WORKFLOW, not an invented label", async () => {
    const { row } = await inserted();
    expect(row.source).toBe("WORKFLOW");
    expect(row.source_ref_id).toBeNull();
  });

  it("type is CALL", async () => {
    expect((await inserted()).row.type).toBe("CALL");
  });

  it("priority is HIGH", async () => {
    expect((await inserted()).row.priority).toBe("HIGH");
  });

  it("status is left to the default, which is allowed", async () => {
    const { row } = await inserted();
    expect(Object.keys(row)).not.toContain("status");
    expect(MIG).toMatch(/status text NOT NULL DEFAULT 'NOT_STARTED' CHECK/);
  });

  it("every constrained column the insert writes is within its CHECK list", async () => {
    const checks = constraints();
    expect(Object.keys(checks)).toEqual(expect.arrayContaining(["silo", "type", "priority", "source", "status"]));
    for (const silo of ["BF", null]) {
      const { row } = await inserted(silo);
      for (const [col, value] of Object.entries(row)) {
        if (checks[col]) expect(checks[col], `${col}=${String(value)}`).toContain(value);
      }
    }
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
  it("stamps only after a successful insert", async () => {
    const { query } = await inserted();
    const sqls = query.mock.calls.map((c) => sqlText(c[0]));
    expect(sqls.findIndex((s) => s.includes("abandon_task_created_at = now()"))).toBeGreaterThan(sqls.findIndex((s) => s.includes("INSERT INTO tasks")));

    const failing = vi.fn(answerBySql([
      [/abandon_task_created_at IS NULL/, { rows: [{ id: "app-1", contact_id: "c-1", silo: "BF", phone: null }] }],
      [/INSERT INTO tasks/, new Error("violates check constraint tasks_source_check")],
    ]));
    const worker = startAbandonedApplicationWorker({ query: failing } as unknown as Pool);
    await h.tick;
    worker.stop();
    expect(callsMatching(failing, "abandon_task_created_at = now()")).toHaveLength(0);
  });
});
