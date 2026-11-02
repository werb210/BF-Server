// BF_SERVER_v869_SETTINGS_PACK_LEAD_ROTATION - round-robin owners for new website, booking and form leads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { assignRotatingOwner, nextInTurn, normalizeRotation } from "../leadRotation.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let settings: unknown;
let lastAssigned: Array<{ user_id: string; last_at: string }>;
let ownerFree: boolean;
let audits: unknown[];
function fake() {
  h.query.mockImplementation(answerBySql([
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === A ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/FROM boreal_settings WHERE key = \$1/, () => ({ rows: settings ? [{ value: settings }] : [] })],
    [/INSERT INTO boreal_settings/, (_s: string, p?: unknown[]) => { settings = JSON.parse(String(p?.[1])); return { rows: [] }; }],
    [/SELECT id::text AS id FROM users\s+WHERE id::text = ANY/, (_s: string, p?: unknown[]) => ({ rows: (p?.[0] as string[]).filter((x) => x !== C).map((id) => ({ id })) })],
    [/FROM lead_rotation_assignments WHERE user_id::text = ANY/, () => ({ rows: lastAssigned })],
    [/UPDATE contacts SET owner_id = \$2::uuid/, () => ({ rows: ownerFree ? [{ id: CONTACT }] : [] })],
    [/FROM users\s+WHERE COALESCE\(active, true\)/, { rows: [{ id: A, first_name: "Jane", last_name: "Smith", role: "Admin" }, { id: B, first_name: "Raj", last_name: "Patel", role: "Staff" }] }],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push(p?.[4]); return { rows: [] }; }],
  ]));
}

beforeEach(() => {
  h.query.mockReset();
  settings = { enabled: true, user_ids: [A, B, C], sources: { website: true, booking: true, form: false }, away_user_ids: [] };
  lastAssigned = []; ownerFree = true; audits = [];
  fake();
});

describe("who is next", () => {
  it("least recently assigned first; never-assigned before anyone; ties keep the Admin's order", () => {
    expect(nextInTurn([A, B], new Map())).toBe(A);
    expect(nextInTurn([A, B], new Map([[A, 2000], [B, 1000]]))).toBe(B);
    expect(nextInTurn([A, B], new Map([[A, 2000]]))).toBe(B);
    expect(nextInTurn([], new Map())).toBeNull();
  });

  it("normalises settings: every source on unless switched off, only real ids", () => {
    expect(normalizeRotation({ enabled: true, user_ids: [A, "nope", A], sources: { form: false } })).toEqual({
      enabled: true, user_ids: [A], sources: { website: true, booking: true, form: false }, away_user_ids: [],
    });
  });
});

describe("assigning a new lead", () => {
  const db = () => ({ query: h.query }) as any;

  it("gives the lead to the next person, logs it and puts it on the timeline", async () => {
    lastAssigned = [{ user_id: A, last_at: "2026-10-26T10:00:00Z" }];
    expect(await assignRotatingOwner(db(), CONTACT, "website")).toBe(B);
    expect(callsMatching(h.query, /UPDATE contacts SET owner_id/)[0]![1]).toEqual([CONTACT, B, null]);
    expect(callsMatching(h.query, /INSERT INTO lead_rotation_assignments/)[0]![1]).toEqual([CONTACT, B, "website", "BF"]);
    expect(callsMatching(h.query, /INSERT INTO crm_timeline_events/)[0]![1]![0]).toBe(CONTACT);
  });

  it("skips people who are away or no longer active", async () => {
    settings = { enabled: true, user_ids: [A, B, C], away_user_ids: [A] };
    expect(await assignRotatingOwner(db(), CONTACT, "booking")).toBe(B);
    settings = { enabled: true, user_ids: [A, C], away_user_ids: [A] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await assignRotatingOwner(db(), CONTACT, "booking")).toBeNull();
    warn.mockRestore();
    expect(callsMatching(h.query, /UPDATE contacts SET owner_id/)).toHaveLength(1);
  });

  it("does nothing when off, for a source not covered, or when the contact already has an owner", async () => {
    expect(await assignRotatingOwner(db(), CONTACT, "form")).toBeNull();
    settings = { enabled: false, user_ids: [A] };
    expect(await assignRotatingOwner(db(), CONTACT, "website")).toBeNull();
    settings = { enabled: true, user_ids: [A] };
    ownerFree = false;
    expect(await assignRotatingOwner(db(), CONTACT, "website")).toBeNull();
    expect(callsMatching(h.query, /INSERT INTO lead_rotation_assignments/)).toHaveLength(0);
  });

  it("a team booking hands the lead from the person booked to the person next in turn", async () => {
    await assignRotatingOwner(db(), CONTACT, "booking", { replaceOwnerId: B });
    expect(callsMatching(h.query, /UPDATE contacts SET owner_id/)[0]![1]).toEqual([CONTACT, A, B]);
  });
});

describe("Settings > Lead rotation", () => {
  const tok = (id: string) => jwt.sign({ sub: id, id, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
  async function app() {
    const router = (await import("../../routes/leadRotation.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/lead-rotation", router);
    return a;
  }

  it("Admins choose the people and sources (audited); inactive people are refused", async () => {
    const a = await app();
    const bad = await request(a).put("/api/lead-rotation").set("Authorization", `Bearer ${tok(A)}`).send({ settings: { enabled: true, user_ids: [A, C] } });
    expect(bad.status).toBe(400);
    const ok = await request(a).put("/api/lead-rotation").set("Authorization", `Bearer ${tok(A)}`).send({ settings: { enabled: true, user_ids: [A, B], sources: { form: false } } });
    expect(ok.status).toBe(200);
    expect(settings).toMatchObject({ enabled: true, user_ids: [A, B], sources: { website: true, booking: true, form: false } });
    expect(audits).toContain("lead_rotation.updated");
    expect((await request(a).put("/api/lead-rotation").set("Authorization", `Bearer ${tok(B)}`).send({ settings: {} })).status).toBe(403);
  });

  it("staff mark themselves away and back", async () => {
    const a = await app();
    await request(a).put("/api/lead-rotation/me").set("Authorization", `Bearer ${tok(B)}`).send({ away: true });
    expect((settings as any).away_user_ids).toEqual([B]);
    const me = await request(a).get("/api/lead-rotation/me").set("Authorization", `Bearer ${tok(B)}`);
    expect(me.body).toEqual({ ok: true, silo: "BF", enabled: true, member: true, away: true });
    await request(a).put("/api/lead-rotation/me").set("Authorization", `Bearer ${tok(B)}`).send({ away: false });
    expect((settings as any).away_user_ids).toEqual([]);
    expect(audits).toEqual(expect.arrayContaining(["lead_rotation.away", "lead_rotation.back"]));
  });
});
