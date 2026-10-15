// BF_SERVER_ABANDON_ATTEMPT_CAP_v1
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// BF_SERVER_v809_SMS_UPDATES_CONSENT - this client ticked "Text me updates"; the consent gate has its own tests.
vi.mock("../../services/smsUpdatesConsent.js", () => ({ smsUpdatesAllowed: async () => true }));
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null, log: [] as string[], sendable: true }));
vi.mock("../claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../../services/smsService.js", () => ({ sendSMS: vi.fn(async (to: string) => { h.log.push("SEND " + to); }) }));
vi.mock("../../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));
vi.mock("../../lib/smsDeliverability.js", async (orig) => {
  const real: any = await orig();
  return { ...real, isSendableBody: (b: unknown) => h.sendable && real.isSendableBody(b) };
});

import { sendSMS } from "../../services/smsService.js";
import { isUndeliverableNumber } from "../../lib/smsDeliverability.js";
import { startAbandonedApplicationWorker } from "../abandonedApplicationWorker.js";

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../../migrations/2026_09_08_v160_abandon_attempts.sql"), "utf8");

async function tick(rows: Array<{ id: string; phone: string }>) {
  const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
    h.log.push(sqlText(sql));
    return answerBySql([[/abandon_sms_sent_at IS NULL/, { rows: rows.map((r) => ({ ...r, contact_id: "c-" + r.id, silo: "BF" })) }]])(sql, params);
  });
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  return query;
}

beforeEach(() => {
  h.log.length = 0;
  h.sendable = true;
  vi.mocked(sendSMS).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("no failure mode can retry forever", () => {
  it("stops selecting a row after three attempts", async () => {
    // v119 handles permanent codes; a transient failure that never succeeds was
    // still unbounded, which is how the original incident began.
    const query = await tick([]);
    const [select] = callsMatching(query, /abandon_sms_sent_at IS NULL/);
    expect(sqlText(select![0])).toContain("COALESCE(a.abandon_sms_attempts, 0) < 3");
  });

  it("counts the attempt before sending, not after", async () => {
    await tick([{ id: "app-1", phone: "+14035230100" }]);
    const increment = h.log.findIndex((s) => s.includes("abandon_sms_attempts = COALESCE(abandon_sms_attempts, 0) + 1"));
    const send = h.log.indexOf("SEND +14035230100");
    expect(increment).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(increment);
  });

  it("checks deliverability at send time, not only in SQL", async () => {
    // A number that slipped past the SQL patterns still never reaches Twilio.
    const query = await tick([{ id: "app-1", phone: "+15555555555" }, { id: "app-2", phone: "+14035230100" }]);
    expect(sendSMS).toHaveBeenCalledTimes(1);
    expect(sendSMS).toHaveBeenCalledWith("+14035230100", expect.any(String));
    expect(callsMatching(query, "abandon_sms_attempts = COALESCE").map((c) => c[1])).toEqual([["app-2"]]);

    // And an empty body is never sent either.
    h.sendable = false;
    vi.mocked(sendSMS).mockClear();
    await tick([{ id: "app-3", phone: "+14035230100" }]);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("retires an undeliverable row rather than leaving it eligible", async () => {
    const query = await tick([{ id: "app-1", phone: "1111111111" }]);
    expect(callsMatching(query, "abandon_sms_sent_at = now()").map((c) => c[1])).toEqual([["app-1"]]);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it("still rejects the numbers from the incident", () => {
    for (const n of ["+15555555555", "5555555555", "+11111111111"]) {
      expect(isUndeliverableNumber(n)).toBe(true);
    }
  });

  it("uses an idempotent migration like every other one here", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_attempts");
  });
});
