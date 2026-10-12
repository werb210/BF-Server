// BF_SERVER_CALL_OUTCOME_CRM_v273
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real = await orig<typeof import("../../../db.js")>();
  return { ...real, pool: { query: h.queryMock } };
});
import { CALL_DISPOSITIONS } from "../callDisposition.js";
import { applyDispositionCrmUpdate, describeCrmUpdate, DISPOSITION_CRM_RULES, safeDispositionCrmUpdate } from "../dispositionCrmUpdate.js";
import telephonyRouter from "../../../telephony/routes/telephonyRoutes.js";
import watchDataRouter from "../../../watch/dataRoutes.js";
import { issueWatchAccessToken } from "../../../watch/security.js";

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
  const CALL = "22222222-2222-4222-8222-222222222222";
  const STAFF = "33333333-3333-4333-8333-333333333333";
  const db = () => {
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([
      [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: "s1", staff_user_id: STAFF, role: "Staff", silo: "BF", silos: [] }] }],
      [/UPDATE call_logs SET disposition/, { rows: [{ id: CALL, contact_id: CONTACT, silo: "BF" }], rowCount: 1 }],
      [/SET lead_status/, (_s: string, p?: unknown[]) => ({ rows: [{ lead_status: p?.[1] }] })],
      [/marketing_sequence_enrollments/, { rows: [{ id: "e1" }] }],
    ]));
  };
  const contactUpdates = () => callsMatching(h.queryMock, /SET lead_status/).map((c) => c[1] as unknown[]);
  const note = () => String((callsMatching(h.queryMock, /INSERT INTO crm_notes/)[0]?.[1] as unknown[] | undefined)?.[0] ?? "");

  it("the dialer/portal route and the Watch route both apply it", async () => {
    db();
    const app = express();
    app.use(express.json());
    app.use("/api/telephony", telephonyRouter);
    const staff = jwt.sign({ sub: STAFF, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const dialer = await request(app).post(`/api/telephony/calls/${CALL}/disposition`).set("Authorization", "Bearer " + staff).send({ disposition: "not_interested" });
    expect(dialer.status).toBe(200);
    expect(dialer.body.data.crmUpdate).toEqual({ leadStatus: "Unqualified", sequencesStopped: 1, optedOut: false });
    expect(contactUpdates()[0].slice(0, 2)).toEqual([CONTACT, "Unqualified"]);
    expect(note()).toContain("lead status set to Unqualified");

    db();
    const watchApp = express();
    watchApp.use(express.json());
    watchApp.use("/api/watch", watchDataRouter);
    const { accessToken } = issueWatchAccessToken(STAFF, "device-1", "session-1");
    const watch = await request(watchApp).post(`/api/watch/calls/${CALL}/disposition`).set("Authorization", "Bearer " + accessToken).send({ disposition: "do_not_contact" });
    expect(watch.status).toBe(200);
    expect(watch.body.crmUpdate).toEqual({ leadStatus: "Do not contact", sequencesStopped: 1, optedOut: true });
    expect(contactUpdates()[0].slice(0, 2)).toEqual([CONTACT, "Do not contact"]);
    expect(note()).toContain("marketing email and SMS turned off");
  });
});
