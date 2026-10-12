// BF_SERVER_v789_MAYA_MKT_CONFIRM - a Maya marketing send needs its own preview's
// pending_action_id (same staff user, 15 minutes, single use), and tests go only to
// the staff user's own email or phone.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const STAFF = "11111111-1111-4111-8111-111111111111";
const OTHER_STAFF = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; kind: string; payload: any; staff_user_id: string | null; status: string; created_at: number; expires_at: number };
const h = vi.hoisted(() => ({ rows: [] as any[], seq: 0, sent: [] as any[], sms: [] as any[], jobs: [] as any[], ran: [] as any[] }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params: any[] = []) => {
    const rows = h.rows as Row[];
    if (/FROM users\s+WHERE id::text = \$1 AND COALESCE\(disabled, false\) = false/.test(sql)) {
      if (params[0] === STAFF) return { rows: [{ email: "Sam@Boreal.test", o365_user_email: null, phone: "+1 (780) 555-0100", phone_number: null }] };
      if (params[0] === OTHER_STAFF) return { rows: [{ email: "other@boreal.test", o365_user_email: null, phone: "+17805550199", phone_number: null }] };
      return { rows: [] };
    }
    if (/INSERT INTO maya_pending_actions/.test(sql)) {
      h.seq += 1;
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(h.seq).padStart(12, "0")}`;
      expect(sql).toContain("'marketing_send'");
      rows.push({ id, kind: "marketing_send", payload: JSON.parse(params[0]), staff_user_id: params[1], status: "pending", created_at: Date.now(), expires_at: Date.now() + Number(params[3]) * 60_000 });
      return { rows: [{ id }] };
    }
    if (/UPDATE maya_pending_actions\s+SET status = 'consumed'/.test(sql)) {
      const [id, staff, fp, mins] = params;
      const x = rows.find((r) => r.id === id && r.kind === "marketing_send" && r.status === "pending" && r.staff_user_id === staff
        && r.payload.fingerprint === fp && r.expires_at > Date.now() && r.created_at > Date.now() - Number(mins) * 60_000);
      if (!x) return { rows: [] };
      x.status = "consumed";
      return { rows: [{ id: x.id }] };
    }
    if (/INSERT INTO marketing_send_jobs/.test(sql)) {
      h.jobs.push(params);
      return { rows: [{ id: "job-1", not_before: "later" }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query } };
});
vi.mock("../services/sendgridService.js", () => ({
  sendgridConfigured: () => true,
  sendOne: async (m: any) => { h.sent.push(m); return { ok: true }; },
  mergeFields: (s: string) => s,
}));
vi.mock("../services/marketingSms.js", () => ({
  smsMarketingConfigured: () => true,
  sendMarketingSms: async (to: string) => { h.sms.push(to); return { ok: true }; },
  renderMarketingSms: (o: any) => o.body,
}));
vi.mock("../services/marketingSendRunner.js", () => ({
  countEmailRecipients: async () => 12,
  countSmsRecipients: async () => 7,
  runEmailSend: async (_p: unknown, o: any) => { h.ran.push(o); return { total: 12, sent: 12, failed: 0 }; },
  runSmsSend: async () => ({}),
  phone10: (p: string | null | undefined) => String(p ?? "").replace(/[^0-9]/g, "").slice(-10),
}));
vi.mock("../services/landingPage.service.js", () => ({
  createLandingPageFromHtml: async () => ({ url: "https://x.test/v" }),
  withViewInBrowser: (html: string) => html,
}));

import mayaStaff from "../routes/mayaStaff.js";

const app = express(); app.use(express.json()); app.use("/api/maya", mayaStaff);
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const send = (body: Record<string, unknown>) => request(app).post("/api/maya/staff/marketing-send").set("Authorization", svc).send(body);
const EMAIL = { channel: "email", silo: "BF", tag: "vip", subject: "Hello", html: "<p>Hi</p>" };
const SMS = { channel: "sms", silo: "BF", tag: "vip", body: "Rates dropped" };

beforeEach(() => { h.rows.length = 0; h.sent.length = 0; h.sms.length = 0; h.jobs.length = 0; h.ran.length = 0; });

describe("v789 Maya marketing send needs its own preview", () => {
  it("preview returns a pending_action_id and sends nothing", async () => {
    const r = await send({ ...EMAIL, user_id: STAFF });
    expect(r.body).toMatchObject({ ok: true, preview: true, recipients: 12, expires_in_minutes: 15 });
    expect(r.body.pending_action_id).toMatch(/^aaaaaaaa-/);
    expect(h.rows[0]).toMatchObject({ staff_user_id: STAFF, status: "pending" });
    expect(h.rows[0].expires_at - h.rows[0].created_at).toBeLessThanOrEqual(15 * 60_000);
    expect(h.ran).toEqual([]);
  });

  it("confirm without a pending_action_id is refused", async () => {
    const r = await send({ ...EMAIL, user_id: STAFF, confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("pending_action_required");
    expect(h.ran).toEqual([]);
  });

  it("confirm with its preview id sends once; a replay is refused", async () => {
    const p = await send({ ...EMAIL, user_id: STAFF });
    const id = p.body.pending_action_id;
    const ok = await send({ ...EMAIL, user_id: STAFF, confirm: true, pending_action_id: id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, sent: true });
    expect(h.ran).toHaveLength(1);
    const again = await send({ ...EMAIL, user_id: STAFF, confirm: true, pending_action_id: id });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("pending_action_invalid");
    expect(h.ran).toHaveLength(1);
  });

  it("another staff user cannot use the preview", async () => {
    const p = await send({ ...EMAIL, user_id: STAFF });
    const r = await send({ ...EMAIL, user_id: OTHER_STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(r.status).toBe(409);
    expect(h.ran).toEqual([]);
  });

  it("changing the content or segment after the preview is refused", async () => {
    const p = await send({ ...EMAIL, user_id: STAFF });
    const changed = await send({ ...EMAIL, html: "<p>Different</p>", user_id: STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(changed.status).toBe(409);
    const otherTag = await send({ ...EMAIL, tag: "another-segment", user_id: STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(otherTag.status).toBe(409);
    expect(h.ran).toEqual([]);
  });

  it("a preview older than 15 minutes is refused", async () => {
    const p = await send({ ...EMAIL, user_id: STAFF });
    h.rows[0].created_at -= 16 * 60_000;
    h.rows[0].expires_at -= 16 * 60_000;
    const r = await send({ ...EMAIL, user_id: STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(r.status).toBe(409);
    expect(h.ran).toEqual([]);
  });

  it("SMS confirm also needs its preview, and queues once", async () => {
    const none = await send({ ...SMS, user_id: STAFF, confirm: true });
    expect(none.status).toBe(400);
    const p = await send({ ...SMS, user_id: STAFF });
    const ok = await send({ ...SMS, user_id: STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(ok.body).toMatchObject({ ok: true, queued: true });
    const again = await send({ ...SMS, user_id: STAFF, confirm: true, pending_action_id: p.body.pending_action_id });
    expect(again.status).toBe(409);
    expect(h.jobs).toHaveLength(1);
  });

  it("confirm without a staff user is refused", async () => {
    const r = await send({ ...EMAIL, confirm: true, pending_action_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("staff_user_required");
  });
});

describe("v789 Maya marketing test sends go only to the staff user", () => {
  it("email test to the staff user's own address is sent", async () => {
    const r = await send({ ...EMAIL, user_id: STAFF, test: "sam@boreal.test" });
    expect(r.body).toMatchObject({ ok: true, test: true });
    expect(h.sent.map((m) => m.to)).toEqual(["sam@boreal.test"]);
  });
  it("email test to anyone else is refused", async () => {
    const r = await send({ ...EMAIL, user_id: STAFF, test: "victim@example.com" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("test_recipient_not_staff");
    const noUser = await send({ ...EMAIL, test: "sam@boreal.test" });
    expect(noUser.status).toBe(403);
    expect(h.sent).toEqual([]);
  });
  it("SMS test only to the staff user's own phone", async () => {
    expect((await send({ ...SMS, staff_user_id: STAFF, test: "780-555-0100" })).body).toMatchObject({ ok: true, test: true });
    expect((await send({ ...SMS, staff_user_id: STAFF, test: "+17805550199" })).status).toBe(403);
    expect(h.sms).toEqual(["780-555-0100"]);
  });
});

describe("v789 maya email blast audience", () => {
  it("refuses an email blast with no tag (whole silo)", async () => {
    const r = await send({ ...EMAIL, tag: null, user_id: STAFF });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("audience_required");
  });
});

describe("v789 runEmailSend refuses a job with no audience", () => {
  it("returns audience_required without querying recipients", async () => {
    const { runEmailSend } = await vi.importActual<typeof import("../services/marketingSendRunner.js")>("../services/marketingSendRunner.js");
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const out = await runEmailSend({ query } as any, { silo: "BF", tag: null, tags: [], subject: "s", html: "h" });
    expect(out.rejectError).toBe("audience_required");
    expect(query).not.toHaveBeenCalled();
  });
});
