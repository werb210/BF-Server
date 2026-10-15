// BF_SERVER_ABANDONED_NUDGE_v61 - Todd was texting every abandoned applicant
// by hand. This does it on a schedule and books the follow-up call.
// v789: drives the real worker tick against a SQL-content-mocked pool.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
// BF_SERVER_v809_SMS_UPDATES_CONSENT - this client ticked "Text me updates"; the consent gate has its own tests.
vi.mock("../services/smsUpdatesConsent.js", () => ({ smsUpdatesAllowed: async () => true }));
import fs from "node:fs";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";
import { bootIndex, type Boot } from "./helpers/bootIndex.js";

const order: string[] = [];
const sendSMS = vi.fn(async (to: string) => { order.push(`sms:${to}`); return { success: true }; });
vi.mock("../services/smsService.js", () => ({ sendSMS: (...a: [string]) => sendSMS(...a) }));
vi.mock("../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));

import { startAbandonedApplicationWorker, ABANDON_SMS_BODY } from "../workers/abandonedApplicationWorker.js";

const MIG = fs.readFileSync("migrations/2026_08_22_v61_abandoned_nudge.sql", "utf8");

const SMS_SELECT = /FROM applications a\s+JOIN contacts c ON c\.id = a\.contact_id/;
const CALL_SELECT = /JOIN contacts AS c ON c\.id = a\.contact_id/;

function makePool(rules: SqlRule[]) {
  const query = vi.fn(answerBySql(rules));
  const wrapped = vi.fn(async (sql: unknown, params?: unknown[]) => {
    order.push(`sql:${String(sql).replace(/\s+/g, " ").trim().slice(0, 60)}`);
    return query(sql, params);
  });
  return { query: wrapped } as any;
}

async function runTick(pool: { query: ReturnType<typeof vi.fn> }) {
  const w = startAbandonedApplicationWorker(pool as any);
  // The tick has finished once the call-task SELECT has been answered and its rows processed.
  await vi.waitFor(() => expect(callsMatching(pool.query, CALL_SELECT).length).toBe(1));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  w.stop();
}

const smsRow = { id: "app-1", contact_id: "c-1", phone: "+14038721234", silo: "BF" };
const stampSql = /UPDATE applications SET abandon_sms_sent_at = now\(\)/;

beforeEach(() => { order.length = 0; sendSMS.mockReset(); sendSMS.mockImplementation(async (to: string) => { order.push(`sms:${to}`); return { success: true }; }); });
afterEach(() => vi.restoreAllMocks());

describe("timing", () => {
  it("texts 4 hours after last activity", async () => {
    const pool = makePool([]);
    await runTick(pool);
    const [sql, params] = callsMatching(pool.query, SMS_SELECT)[0] as [string, string[]];
    expect(sql).toMatch(/a\.updated_at < \(\$1 \|\| ' hours'\)::interval \* -1 \+ now\(\)/);
    expect(params[0]).toBe("4");
  });

  it("books the call task 2 days after", async () => {
    const pool = makePool([]);
    await runTick(pool);
    const [sql, params] = callsMatching(pool.query, CALL_SELECT)[0] as [string, string[]];
    expect(sql).toMatch(/a\.updated_at < now\(\) - \(\$1 \|\| ' days'\)::interval/);
    expect(params[0]).toBe("2");
  });
});

describe("it cannot text the same person twice", () => {
  it("only selects unstamped applications and stamps the application once sent", async () => {
    const pool = makePool([[SMS_SELECT, { rows: [smsRow] }]]);
    await runTick(pool);
    expect(callsMatching(pool.query, SMS_SELECT)[0][0]).toContain("a.abandon_sms_sent_at IS NULL");
    expect(sendSMS).toHaveBeenCalledWith(smsRow.phone, ABANDON_SMS_BODY);
    const stamps = callsMatching(pool.query, stampSql);
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual(["app-1"]);
  });

  it("stamps only AFTER a successful send, so an outage retries", async () => {
    const pool = makePool([[SMS_SELECT, { rows: [smsRow] }]]);
    await runTick(pool);
    const sent = order.indexOf(`sms:${smsRow.phone}`);
    const stamp = order.findIndex((e) => e.startsWith("sql:UPDATE applications SET abandon_sms_sent_at = now()"));
    expect(sent).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(sent);
  });

  it("a transient send failure leaves the row eligible (no stamp)", async () => {
    sendSMS.mockRejectedValue(Object.assign(new Error("twilio 503"), { status: 503 }));
    const pool = makePool([
      [SMS_SELECT, { rows: [smsRow] }],
      [/RETURNING abandon_sms_attempts/, { rows: [{ abandon_sms_attempts: 1 }] }],
    ]);
    await runTick(pool);
    expect(sendSMS).toHaveBeenCalledTimes(1);
    expect(callsMatching(pool.query, stampSql)).toHaveLength(0);
  });

  it("only a permanent rejection may stamp from the failure path (v119)", async () => {
    sendSMS.mockRejectedValue(Object.assign(new Error("invalid to"), { code: 21211 }));
    const pool = makePool([
      [SMS_SELECT, { rows: [smsRow] }],
      [/RETURNING abandon_sms_attempts/, { rows: [{ abandon_sms_attempts: 1 }] }],
    ]);
    await runTick(pool);
    expect(callsMatching(pool.query, stampSql)).toHaveLength(1);
  });

  it("an undeliverable number is retired before any send", async () => {
    const pool = makePool([[SMS_SELECT, { rows: [{ ...smsRow, phone: "+15555555555" }] }]]);
    await runTick(pool);
    expect(sendSMS).not.toHaveBeenCalled();
    expect(callsMatching(pool.query, stampSql)[0][1]).toEqual(["app-1"]);
  });

  it("does the same for the call task", async () => {
    const pool = makePool([[CALL_SELECT, { rows: [{ id: "app-2", contact_id: "c-2", silo: "BF", phone: "+14038721234" }] }]]);
    await runTick(pool);
    expect(callsMatching(pool.query, CALL_SELECT)[0][0]).toContain("a.abandon_task_created_at IS NULL");
    const stamp = callsMatching(pool.query, /UPDATE applications SET abandon_task_created_at = now\(\)/);
    expect(stamp).toHaveLength(1);
    expect(stamp[0][1]).toEqual(["app-2"]);
  });

  it("does not stamp the call task when the insert fails", async () => {
    const pool = makePool([
      [CALL_SELECT, { rows: [{ id: "app-2", contact_id: "c-2", silo: "BF", phone: null }] }],
      [/INSERT INTO tasks/, new Error("check constraint")],
    ]);
    await runTick(pool);
    expect(callsMatching(pool.query, /abandon_task_created_at = now\(\)/)).toHaveLength(0);
  });
});

describe("consent", () => {
  it("respects STOP replies", async () => {
    const pool = makePool([]);
    await runTick(pool);
    expect(callsMatching(pool.query, SMS_SELECT)[0][0]).toContain("COALESCE(c.sms_opt_out, false) = false");
  });

  it("stops contacting after the 6-month CASL implied-consent window", async () => {
    const pool = makePool([]);
    await runTick(pool);
    for (const re of [SMS_SELECT, CALL_SELECT]) {
      const [sql, params] = callsMatching(pool.query, re)[0] as [string, string[]];
      expect(sql).toMatch(/a\.updated_at > now\(\) - \(\$2 \|\| ' months'\)::interval/);
      expect(params[1]).toBe("6");
    }
  });

  it("never texts a blank number", async () => {
    const pool = makePool([[SMS_SELECT, { rows: [{ ...smsRow, phone: "  " }] }]]);
    await runTick(pool);
    expect(callsMatching(pool.query, SMS_SELECT)[0][0]).toContain("btrim(c.phone) <> ''");
    expect(sendSMS).not.toHaveBeenCalled();
  });
});

describe("the task", () => {
  const callRow = { id: "app-3", contact_id: "c-3", silo: null, phone: "+14038721234" };

  it("goes to the contact owner, never the seeded admin", async () => {
    const pool = makePool([[CALL_SELECT, { rows: [callRow] }]]);
    await runTick(pool);
    const [sql, params] = callsMatching(pool.query, /INSERT INTO tasks/)[0] as [string, unknown[]];
    expect(sql).toContain("SELECT owner_id FROM contacts WHERE id = $4");
    expect(sql).toContain("id::text <> '00000000-0000-0000-0000-000000000099'");
    expect(params[3]).toBe("c-3");
  });

  it("is findable as a group", async () => {
    // BF_SERVER_ABANDON_TEST_v66 - tasks.source only permits MANUAL|SEQUENCE|WORKFLOW|IMPORT|API.
    // These tasks are identified by their title instead.
    const pool = makePool([[CALL_SELECT, { rows: [callRow] }]]);
    await runTick(pool);
    const [sql, params] = callsMatching(pool.query, /INSERT INTO tasks/)[0] as [string, unknown[]];
    expect(sql).toContain("'WORKFLOW', NULL)");
    expect(sql).not.toContain("'ABANDONED_APPLICATION'");
    expect(params[0]).toBe("BF");
    expect(params[1]).toBe("Call: started an application, did not finish");
  });
});

describe("wiring", () => {
  let boot: Boot | null = null;
  afterEach(() => { boot?.restore(); boot = null; });

  it("is idempotent and indexed", () => {
    expect(MIG).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_sent_at");
    expect(MIG).toContain("CREATE INDEX IF NOT EXISTS idx_applications_abandon_nudge");
  });

  it("starts with the other workers", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    expect(boot.started()).toContain("startAbandonedApplicationWorker");
    expect(boot.workerCalls.get("startAbandonedApplicationWorker")![0][0]).toBe(boot.pool);
  });
});
