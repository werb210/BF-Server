// BF_SERVER_v864_OOO_UNTIL - "Active until" turns out of office on now and off at the end of the chosen day,
// in the user's zone (Alberta / Manitoba / B.C. on permanent time from 2026).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runQuery } = vi.hoisted(() => ({ runQuery: vi.fn() }));
vi.mock("../db.js", () => ({ runQuery, pool: { query: runQuery } }));

import { computeZone, endOfLocalDayUtc, localDateIn } from "../lib/permanentTime.js";
import { planOutOfOffice, isPlanError, recordBorealOutOfOffice } from "../modules/o365/outOfOffice.js";
import { explainPresence } from "../modules/presence/explainPresence.js";
import { ringableStaffSql } from "../modules/presence/presenceService.js";

describe("permanent time zones (v864)", () => {
  it("computes Edmonton, Winnipeg and Vancouver with the same offset all year", () => {
    expect(computeZone("America/Edmonton")).toBe("America/Regina");
    expect(computeZone("America/Winnipeg")).toBe("Etc/GMT+5");
    expect(computeZone("America/Vancouver")).toBe("Etc/GMT+7");
    expect(computeZone("America/Toronto")).toBe("America/Toronto");
    expect(computeZone("not a zone")).toBe("America/Regina");
  });

  it("ends a winter day in Alberta at 06:00 UTC the next morning (UTC-6, no fall-back)", () => {
    expect(endOfLocalDayUtc("2026-11-20", "America/Edmonton")!.toISOString()).toBe("2026-11-21T06:00:00.000Z");
    expect(endOfLocalDayUtc("2026-11-20", "America/Winnipeg")!.toISOString()).toBe("2026-11-21T05:00:00.000Z");
    expect(endOfLocalDayUtc("2026-11-20", "America/Vancouver")!.toISOString()).toBe("2026-11-21T07:00:00.000Z");
    // Toronto still changes clocks: EST in November.
    expect(endOfLocalDayUtc("2026-11-20", "America/Toronto")!.toISOString()).toBe("2026-11-21T05:00:00.000Z");
    expect(endOfLocalDayUtc("2026-07-20", "America/Toronto")!.toISOString()).toBe("2026-07-21T04:00:00.000Z");
    expect(endOfLocalDayUtc("2026-02-30", "America/Edmonton")).toBeNull();
  });

  it("reads today's date in the user's zone", () => {
    // 03:00 UTC on Nov 2 is still Nov 1 in Alberta.
    expect(localDateIn(new Date("2026-11-02T03:00:00Z"), "America/Edmonton")).toBe("2026-11-01");
  });
});

describe("planOutOfOffice (v864)", () => {
  const NOW = new Date("2026-11-01T17:00:00Z"); // 11:00 in Alberta

  it("On + Active until -> Outlook 'scheduled' from now to the end of that day", () => {
    const p = planOutOfOffice({ status: "alwaysEnabled", activeUntil: "2026-11-05", timeZone: "America/Edmonton", externalReplyMessage: "Away" }, NOW);
    if (isPlanError(p)) throw new Error(p.message);
    expect(p.status).toBe("scheduled");
    expect(p.until!.toISOString()).toBe("2026-11-06T06:00:00.000Z");
    expect(p.from!.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(p.auto.status).toBe("scheduled");
    expect(p.auto.scheduledEndDateTime).toEqual({ dateTime: "2026-11-06T06:00:00.000", timeZone: "UTC" });
    expect((p.auto.scheduledStartDateTime as any).timeZone).toBe("UTC");
    expect(p.auto.externalReplyMessage).toBe("Away");
  });

  it("accepts today (ends tonight) and refuses a day that has passed", () => {
    const today = planOutOfOffice({ status: "alwaysEnabled", activeUntil: "2026-11-01", timeZone: "America/Edmonton" }, NOW);
    if (isPlanError(today)) throw new Error(today.message);
    expect(today.until!.toISOString()).toBe("2026-11-02T06:00:00.000Z");
    const past = planOutOfOffice({ status: "alwaysEnabled", activeUntil: "2026-10-31", timeZone: "America/Edmonton" }, NOW);
    expect(isPlanError(past) && past.error).toBe("active_until_passed");
    const bad = planOutOfOffice({ status: "alwaysEnabled", activeUntil: "31/10/2026" }, NOW);
    expect(isPlanError(bad) && bad.error).toBe("invalid_active_until");
  });

  it("On without a date stays on with no end; Off clears Boreal's window", () => {
    const on = planOutOfOffice({ status: "alwaysEnabled" }, NOW);
    if (isPlanError(on)) throw new Error(on.message);
    expect(on.status).toBe("alwaysEnabled");
    expect(on.from).not.toBeNull();
    expect(on.until).toBeNull();
    expect(on.auto.scheduledEndDateTime).toBeUndefined();
    const off = planOutOfOffice({ status: "disabled" }, NOW);
    if (isPlanError(off)) throw new Error(off.message);
    expect(off.from).toBeNull();
    expect(off.until).toBeNull();
  });
});

describe("Boreal's own out of office (v864)", () => {
  beforeEach(() => {
    runQuery.mockReset();
    runQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
  });

  it("stores the window on staff_presence and shows the team status until the same moment", async () => {
    const NOW = new Date("2026-11-01T17:00:00Z");
    const p = planOutOfOffice({ status: "alwaysEnabled", activeUntil: "2026-11-05", timeZone: "America/Edmonton" }, NOW);
    if (isPlanError(p)) throw new Error(p.message);
    await recordBorealOutOfOffice("00000000-0000-0000-0000-000000000001", p, "America/Edmonton", NOW);
    const calls = runQuery.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }));
    const presence = calls.find((c) => /INSERT INTO staff_presence/.test(c.sql))!;
    expect(presence.params[2]).toEqual(p.until);
    const status = calls.find((c) => /UPDATE team_user_status SET status_text/.test(c.sql))!;
    expect(status.params[1]).toBe("Out of office until Nov 5");
    expect(status.params[2]).toBe("2026-11-06T06:00:00.000Z");
  });

  it("turning it off clears only the out-of-office team status", async () => {
    await recordBorealOutOfOffice("00000000-0000-0000-0000-000000000001", { from: null, until: null }, "America/Edmonton");
    const clear = runQuery.mock.calls.map((c) => String(c[0])).find((s) => /status_text = NULL/.test(s))!;
    expect(clear).toContain("status_text LIKE 'Out of office%'");
    const presence = runQuery.mock.calls.find((c) => /INSERT INTO staff_presence/.test(String(c[0])))!;
    expect((presence[1] as unknown[])[1]).toBeNull();
    expect((presence[1] as unknown[])[2]).toBeNull();
  });

  it("logs instead of throwing when the database write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runQuery.mockRejectedValue(new Error("boom"));
    await expect(recordBorealOutOfOffice("u", { from: new Date(), until: null }, "UTC")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("inbound calls skip someone inside the window; presence explains why and ends it at the end date", () => {
    expect(ringableStaffSql("sp", "u")).toMatch(/sp\.out_of_office_until > now\(\)/);
    const NOON = new Date("2026-11-03T18:00:00Z");
    const row = { user_id: "u1", twilio_identity: "u1", status: "available", last_heartbeat: new Date(NOON.getTime() - 60_000) };
    expect(explainPresence({ ...row, out_of_office_from: "2026-11-01T00:00:00Z", out_of_office_until: "2026-11-06T06:00:00Z" }, NOON).reason).toBe("out_of_office");
    expect(explainPresence({ ...row, out_of_office_from: "2026-11-01T00:00:00Z", out_of_office_until: "2026-11-03T06:00:00Z" }, NOON).reason).toBe("available");
    expect(explainPresence({ ...row, out_of_office_from: "2026-11-01T00:00:00Z", out_of_office_until: "infinity" }, NOON).reason).toBe("out_of_office");
  });
});
