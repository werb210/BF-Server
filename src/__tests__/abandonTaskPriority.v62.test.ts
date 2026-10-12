// BF_SERVER_ABANDON_FIX_v62 - v61 shipped with priority 'high' and every task
// insert failed the CHECK constraint in production.
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
const CALL_ROW = { id: "app-1", contact_id: "c-1", silo: "BF", phone: "+14035550100" };

/** The allowed values of a CHECK (col IN (...)) constraint in the tasks migration. */
function allowed(col: string): string[] {
  const m = MIG.match(new RegExp(`\\b${col} text[^\\n]*CHECK \\(${col} IN \\(([^)]*)\\)\\)`));
  return m ? [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!) : [];
}

/** Split on commas that are not inside parentheses or quotes. */
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

/** column -> value the INSERT actually writes (literal, or the bound parameter). */
function insertedRow(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = splitTop(sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")));
  const valuesStart = sql.indexOf("(", sql.indexOf("VALUES")) + 1;
  const vals = splitTop(sql.slice(valuesStart, sql.lastIndexOf(")")));
  const row: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    const v = vals[i] ?? "";
    const lit = v.match(/^'([^']*)'$/);
    const param = v.match(/^\$(\d+)$/);
    row[c] = lit ? lit[1] : param ? params[Number(param[1]) - 1] : v;
  });
  return row;
}

async function runTick(insertFails = false) {
  const query = vi.fn(answerBySql([
    [/abandon_task_created_at IS NULL/, { rows: [CALL_ROW] }],
    [/INSERT INTO tasks/, insertFails ? new Error('new row for relation "tasks" violates check constraint') : { rows: [], rowCount: 1 }],
  ]));
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  return query;
}

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the task insert satisfies its constraints", () => {
  it("uses an allowed priority", async () => {
    const query = await runTick();
    const [insert] = callsMatching(query, "INSERT INTO tasks");
    const row = insertedRow(sqlText(insert![0]), insert![1] as unknown[]);
    expect(row.priority).toBe("HIGH");
    expect(allowed("priority")).toContain(row.priority);
  });

  it("uses an allowed type", async () => {
    const query = await runTick();
    const [insert] = callsMatching(query, "INSERT INTO tasks");
    const row = insertedRow(sqlText(insert![0]), insert![1] as unknown[]);
    expect(row.type).toBe("CALL");
    expect(allowed("type")).toContain(row.type);
  });

  it("matches what the schema actually permits", () => {
    expect(MIG).toContain("priority IN ('NONE','LOW','MEDIUM','HIGH')");
    expect(MIG).toContain("type IN ('CALL','EMAIL','SMS','TODO')");
    expect(allowed("priority")).toEqual(["NONE", "LOW", "MEDIUM", "HIGH"]);
    expect(allowed("type")).toEqual(["CALL", "EMAIL", "SMS", "TODO"]);
  });
});

describe("the failures self-heal", () => {
  it("only stamps after a successful insert, so every row retries", async () => {
    const ok = await runTick();
    const sqls = ok.mock.calls.map((c) => sqlText(c[0]));
    const insert = sqls.findIndex((s) => s.includes("INSERT INTO tasks"));
    const stamp = sqls.findIndex((s) => s.includes("abandon_task_created_at = now()"));
    expect(insert).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(insert);
    expect(callsMatching(ok, "abandon_task_created_at = now()")[0]![1]).toEqual(["app-1"]);

    const failed = await runTick(true);
    expect(callsMatching(failed, "INSERT INTO tasks")).toHaveLength(1);
    expect(callsMatching(failed, "abandon_task_created_at = now()")).toHaveLength(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => c[0] === "[abandonedApplication] task failed")).toBe(true);
  });
});
