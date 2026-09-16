// BF_SERVER_CALL_OUTCOME_CRM_v273
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { CALL_DISPOSITIONS } from "../callDisposition.js";
import { applyDispositionCrmUpdate, describeCrmUpdate, DISPOSITION_CRM_RULES, safeDispositionCrmUpdate } from "../dispositionCrmUpdate.js";

const CONTACT = "11111111-1111-1111-1111-111111111111";

function fakeQuery(opts: { statusMatches?: boolean; enrollments?: number } = {}) {
  return vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("SET lead_status")) return { rows: opts.statusMatches === false ? [] : [{ lead_status: params[1] }] };
    if (sql.includes("marketing_sequence_enrollments")) return { rows: Array.from({ length: opts.enrollments ?? 0 }, (_, i) => ({ id: String(i) })) };
    return { rows: [] };
  });
}

describe("every call outcome has a CRM rule", () => {
  it("covers the whole disposition catalogue", () => {
    for (const d of CALL_DISPOSITIONS) expect(DISPOSITION_CRM_RULES[d]).toBeTruthy();
  });
});

describe("contact updates", () => {
  it("do not contact turns off email and SMS, stops sequences and says so", async () => {
    const query = fakeQuery({ enrollments: 2 });
    const r = await applyDispositionCrmUpdate(CONTACT, "do_not_contact", query);
    expect(r).toEqual({ leadStatus: "Do not contact", sequencesStopped: 2, optedOut: true });
    expect(query.mock.calls.some((c) => String(c[0]).includes("marketing_opt_out = true, sms_opt_out = true"))).toBe(true);
    expect(describeCrmUpdate(r)).toBe(" · lead status set to Do not contact, marketing email and SMS turned off, 2 sequences stopped");
  });

  it("not interested marks Unqualified and stops sequences but leaves consent alone", async () => {
    const query = fakeQuery({ enrollments: 1 });
    expect(await applyDispositionCrmUpdate(CONTACT, "not_interested", query)).toEqual({ leadStatus: "Unqualified", sequencesStopped: 1, optedOut: false });
    expect(query.mock.calls.some((c) => String(c[0]).includes("marketing_opt_out"))).toBe(false);
    const stop = query.mock.calls.find((c) => String(c[0]).includes("marketing_sequence_enrollments"));
    expect(stop?.[1]).toEqual([CONTACT, "stopped_not_interested"]);
  });

  it("a conversation only upgrades early statuses, never downgrades", async () => {
    const query = fakeQuery();
    await applyDispositionCrmUpdate(CONTACT, "connected", query);
    expect(query.mock.calls[0][1]).toEqual([CONTACT, "Connected", ["New", "Open", "Attempted to contact"]]);
    const qualified = fakeQuery({ statusMatches: false });
    expect((await applyDispositionCrmUpdate(CONTACT, "follow_up", qualified)).leadStatus).toBeNull();
    expect(describeCrmUpdate({ leadStatus: null, sequencesStopped: 0, optedOut: false })).toBe("");
  });

  it("no answer marks Attempted to contact only from New or Open", async () => {
    const query = fakeQuery();
    await applyDispositionCrmUpdate(CONTACT, "no_answer", query);
    expect(query.mock.calls[0][1]).toEqual([CONTACT, "Attempted to contact", ["New", "Open"]]);
  });

  it("never fails the disposition when the update errors, and skips calls with no contact", async () => {
    const boom = vi.fn(async () => { throw new Error("db down"); });
    expect(await safeDispositionCrmUpdate(CONTACT, "connected", boom)).toBeNull();
    expect(await safeDispositionCrmUpdate(null, "connected", boom)).toBeNull();
  });
});

describe("wiring", () => {
  it("the dialer/portal route and the Watch route both apply it", () => {
    expect(fs.readFileSync("src/telephony/routes/telephonyRoutes.ts", "utf8")).toContain("safeDispositionCrmUpdate(row?.contact_id, plan.disposition");
    expect(fs.readFileSync("src/watch/dataRoutes.ts", "utf8")).toContain("safeDispositionCrmUpdate(row?.contact_id, disposition");
  });
});
