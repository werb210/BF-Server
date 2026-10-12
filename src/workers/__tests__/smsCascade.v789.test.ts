// BF_SERVER_v789_SMS_CASCADE_SENT_ONLY_ON_SUCCESS - fallback_sent is set only
// when SendGrid accepted the email; failures are logged and counted. The DB is
// faked and answers by SQL content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const sendOne = vi.fn();
vi.mock("../../services/sendgridService.js", () => ({
  sendOne: (...a: unknown[]) => sendOne(...a),
  mergeFields: (s: string, vars: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? ""),
}));

const lockCalls: string[] = [];
vi.mock("../claim.js", () => ({
  withWorkerLock: async (name: string, fn: () => Promise<unknown>) => { lockCalls.push(name); return { ran: true, result: await fn() }; },
}));

import { runSmsCascadeOnce, startSmsCascadeWorker, SMS_CASCADE_MAX_ATTEMPTS } from "../smsCascadeWorker.js";

const ROW = { id: "s1", contact_id: "c1", email: "a@example.com", name: "Ann Lee", company: "Acme", fallback_subject: "Hi {{first_name}}", fallback_html: "<p>Hi</p>" };

function fakePool(opts: { failSentUpdate?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM sms_campaign_sends s/i.test(sql)) return { rows: [ROW] };
      if (/SET fallback_sent = true/i.test(sql)) {
        if (opts.failSentUpdate) throw new Error("db down");
        return { rows: [], rowCount: 1 };
      }
      if (/SET fallback_attempts/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO crm_timeline_events/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    }),
  };
  return { pool: pool as unknown as Pool, calls };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sendOne.mockReset();
  lockCalls.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("runSmsCascadeOnce", () => {
  it("marks fallback_sent and logs the timeline event when the send succeeds", async () => {
    sendOne.mockImplementation(async () => ({ ok: true, status: 202 }));
    const { pool, calls } = fakePool();
    expect(await runSmsCascadeOnce(pool)).toEqual({ sent: 1, failed: 0 });
    expect(calls.some((c) => /SET fallback_sent = true/i.test(c.sql) && (c.params ?? [])[0] === "s1")).toBe(true);
    expect(calls.some((c) => /crm_timeline_events/i.test(c.sql))).toBe(true);
    expect(sendOne.mock.calls[0][0]).toMatchObject({ to: "a@example.com", subject: "Hi Ann" });
  });

  it("does NOT set fallback_sent when SendGrid rejects; counts the attempt and logs", async () => {
    sendOne.mockImplementation(async () => ({ ok: false, status: 400, error: "bad address" }));
    const { pool, calls } = fakePool();
    expect(await runSmsCascadeOnce(pool)).toEqual({ sent: 0, failed: 1 });
    expect(calls.some((c) => /fallback_sent = true/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /crm_timeline_events/i.test(c.sql))).toBe(false);
    const attempt = calls.find((c) => /SET fallback_attempts/i.test(c.sql));
    expect(attempt?.params?.[0]).toBe("s1");
    expect(String(attempt?.params?.[1])).toContain("400");
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT set fallback_sent when sendOne throws", async () => {
    sendOne.mockImplementation(async () => { throw new Error("socket hang up"); });
    const { pool, calls } = fakePool();
    expect(await runSmsCascadeOnce(pool)).toEqual({ sent: 0, failed: 1 });
    expect(calls.some((c) => /fallback_sent = true/i.test(c.sql))).toBe(false);
  });

  it("selects only rows under the attempt cap", async () => {
    sendOne.mockImplementation(async () => ({ ok: true, status: 202 }));
    const { pool, calls } = fakePool();
    await runSmsCascadeOnce(pool);
    const select = calls.find((c) => /FROM sms_campaign_sends s/i.test(c.sql));
    expect(select?.sql).toMatch(/fallback_attempts, 0\) < \$1/);
    expect(select?.params).toEqual([SMS_CASCADE_MAX_ATTEMPTS]);
  });

  it("logs loudly when the email went out but could not be recorded", async () => {
    sendOne.mockImplementation(async () => ({ ok: true, status: 202 }));
    const { pool } = fakePool({ failSentUpdate: true });
    await runSmsCascadeOnce(pool);
    expect(error.mock.calls.some((c) => String(c[0]).includes("SENT but not recorded"))).toBe(true);
  });
});

describe("startSmsCascadeWorker", () => {
  it("runs each tick under the sms_cascade worker claim and logs a failing tick", async () => {
    vi.useFakeTimers();
    sendOne.mockImplementation(async () => ({ ok: true, status: 202 }));
    const pool = { query: vi.fn(async () => { throw new Error("db unavailable"); }) } as unknown as Pool;
    const w = startSmsCascadeWorker(pool);
    await vi.advanceTimersByTimeAsync(15_000);
    w.stop();
    expect(lockCalls).toEqual(["sms_cascade"]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("[sms-cascade] tick failed"))).toBe(true);
  });
});
