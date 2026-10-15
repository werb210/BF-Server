// BF_SERVER_ABANDON_PERMANENT_FAIL_v119
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
// BF_SERVER_v809_SMS_UPDATES_CONSENT - this client ticked "Text me updates"; the consent gate has its own tests.
vi.mock("../../services/smsUpdatesConsent.js", () => ({ smsUpdatesAllowed: async () => true }));
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null, sendError: null as unknown }));
vi.mock("../claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../../services/smsService.js", () => ({ sendSMS: vi.fn(async () => { if (h.sendError) throw h.sendError; }) }));
vi.mock("../../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));

import { sendSMS } from "../../services/smsService.js";
import { ABANDON_SMS_BODY, startAbandonedApplicationWorker } from "../abandonedApplicationWorker.js";

const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v119_abandon_sms_attempts.sql"),
  "utf-8",
);

const PERMANENT = [21211, 21610, 21612, 21614, 21408, 30003, 30005, 30006];
const ROW = { id: "app-1", contact_id: "c-1", phone: "+14035230100", silo: "BF" };

/** One tick with one due row; the failure counter answers `attempts` (or throws). */
async function tick(opts: { attempts?: number; counterFails?: boolean; rows?: unknown[] } = {}) {
  const query = vi.fn(answerBySql([
    [/abandon_sms_sent_at IS NULL/, { rows: opts.rows ?? [ROW] }],
    [/RETURNING abandon_sms_attempts/, opts.counterFails ? new Error("db down") : { rows: [{ abandon_sms_attempts: opts.attempts ?? 1 }] }],
  ]));
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  return query;
}
const retired = (query: ReturnType<typeof vi.fn>) => callsMatching(query, "SET abandon_sms_sent_at = now()").map((c) => (c[1] as unknown[])[0]);
const warned = (text: string) => vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes(text));

beforeEach(() => {
  h.sendError = null;
  vi.mocked(sendSMS).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("permanent rejections are retired", () => {
  it.each(PERMANENT)("code %i is treated as permanent", async (code) => {
    h.sendError = Object.assign(new Error("twilio"), { code });
    const query = await tick({ attempts: 1 });
    expect(retired(query)).toEqual(["app-1"]);
    expect(vi.mocked(console.warn).mock.calls.find((c) => String(c[0]).includes("sms retired"))?.[1]).toMatchObject({ code, reason: "permanent_rejection" });
  });

  it("21211 - the invalid number that caused this - is covered", () => {
    expect(PERMANENT).toContain(21211);
  });

  it("stamps sent_at so the row leaves the eligible set", async () => {
    h.sendError = Object.assign(new Error("invalid To"), { code: 21211 });
    const query = await tick({ attempts: 1 });
    const [stamp] = callsMatching(query, "SET abandon_sms_sent_at = now()");
    expect(stamp![1]).toEqual(["app-1"]);
  });
});

describe("transient failures still retry", () => {
  it("an unlisted code does not retire on the first failure", async () => {
    h.sendError = Object.assign(new Error("rate limited"), { code: 20429 });
    const query = await tick({ attempts: 1 });
    expect(retired(query)).toEqual([]);
    expect(warned("will retry")).toBe(true);
  });

  it("but stops at three attempts", async () => {
    h.sendError = Object.assign(new Error("rate limited"), { code: 20429 });
    expect(retired(await tick({ attempts: 2 }))).toEqual([]);
    const query = await tick({ attempts: 3 });
    expect(retired(query)).toEqual(["app-1"]);
    expect(vi.mocked(console.warn).mock.calls.find((c) => String(c[0]).includes("sms retired"))?.[1]).toMatchObject({ attempts: 3, reason: "attempt_cap" });
  });
});

describe("the counter", () => {
  it("is added idempotently", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_attempts");
  });

  it("is incremented on every failure", async () => {
    h.sendError = Object.assign(new Error("rate limited"), { code: 20429 });
    const query = await tick({ attempts: 1 });
    const bumps = callsMatching(query, /SET abandon_sms_attempts = abandon_sms_attempts \+ 1/);
    expect(bumps.map((c) => c[1])).toEqual([["app-1"]]);
  });

  it("a failed counter update cannot crash the tick", async () => {
    h.sendError = Object.assign(new Error("rate limited"), { code: 20429 });
    const second = { ...ROW, id: "app-2" };
    const query = await tick({ counterFails: true, rows: [ROW, second] });
    // Both rows were tried, the failure was logged, and the tick went on to the call tasks.
    expect(sendSMS).toHaveBeenCalledTimes(2);
    expect(retired(query)).toEqual([]);
    expect(callsMatching(query, /abandon_task_created_at IS NULL/)).toHaveLength(1);
    expect(warned("tick failed")).toBe(false);
  });
});

describe("success path is unchanged", () => {
  it("still stamps only after a successful send", async () => {
    const query = await tick();
    expect(sendSMS).toHaveBeenCalledWith("+14035230100", ABANDON_SMS_BODY);
    expect(retired(query)).toEqual(["app-1"]);
    expect(callsMatching(query, /SET abandon_sms_attempts = abandon_sms_attempts \+ 1/)).toHaveLength(0);
  });
});
