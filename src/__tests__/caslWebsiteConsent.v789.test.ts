// BF_SERVER_v789_CASL_EXPRESS_CONSENT
// Public website forms record CASL express consent on the contact (the same
// sms_consent / consent_basis / consent_at / consent_source columns the
// applicant consent work uses, plus consent_text) only when casl_consent === true.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({ sqls: [] as Array<{ sql: string; params: unknown[] }>, ip: 1 }));

function answer(sql: string, params: unknown[] = []) {
  state.sqls.push({ sql, params });
  if (sql.includes("RETURNING readiness_score")) return { rows: [{ readiness_score: 50, readiness_tier: "yellow" }], rowCount: 1 };
  if (/UPDATE contacts\s+SET sms_consent/.test(sql)) return { rows: [], rowCount: 1 };
  if (/FROM contacts/.test(sql)) return { rows: [{ id: "k1" }], rowCount: 1 };
  if (/SELECT id FROM communications_conversations/.test(sql)) return { rows: [{ id: "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0" }] };
  if (/INSERT INTO issues/.test(sql)) return { rows: [{ id: "i1" }] };
  if (/INSERT INTO communications_conversations/.test(sql)) return { rows: [{ id: "c1" }] };
  return { rows: [], rowCount: 0 };
}

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../modules/crm/crm.service.js", () => ({ createCrmLead: async () => ({ id: "lead-1" }) }));
vi.mock("../modules/continuation/continuation.service.js", () => ({ createContinuation: async () => "cont-1" }));
vi.mock("../services/contacts.js", () => ({
  createContact: async () => ({ id: "k1" }),
  findOrCreateContactByEmailAndCompany: async () => ({ row: { id: "k1" }, created: false }),
}));
vi.mock("../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: async () => ({ row: { id: "co1" } }) }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: async () => undefined }));
vi.mock("../services/sendgridService.js", () => ({ sendTransactional: async () => undefined, mergeFields: (s: string) => s, sendgridConfigured: () => false }));
vi.mock("../modules/crm/leadUpsert.service.js", () => ({ upsertCrmLead: async () => ({ id: "lead-2" }) }));
vi.mock("../modules/readiness/readiness.service.js", () => ({ linkCrmContact: async () => "k-readiness" }));
vi.mock("../services/clientBooking.js", () => ({
  bookableStaff: async () => [],
  openSlots: async () => [],
  createBooking: async () => ({ ok: true, bookingId: "b1" }),
  bookingPhoneE164: (p: string) => p,
  BookingCalendarError: class extends Error {},
}));
vi.mock("../services/notifications/staffSms.js", () => ({ sendStaffNotification: async () => undefined }));

const CONSENT = {
  casl_consent: true,
  casl_consent_text: "Yes, Boreal Financial may text and email me about financing. I can unsubscribe at any time.",
  casl_consent_at: new Date().toISOString(),
};

const consentWrites = () => state.sqls.filter((s) => /UPDATE contacts\s+SET sms_consent\s+= true/.test(s.sql));
const nextIp = () => `10.2.${Math.floor(state.ip / 250)}.${(state.ip++ % 250) + 1}`;

async function mount(path: string, loader: () => Promise<any>) {
  const a = express();
  a.use(express.json());
  a.use(path, (await loader()).default);
  return a;
}

type Case = {
  name: string;
  send: (extra: Record<string, unknown>) => Promise<request.Response>;
  expectTarget: (params: unknown[]) => void;
  source: string;
};

const cases: Case[] = [
  {
    name: "POST /api/website/contact (lead capture)",
    send: async (extra) => request(await mount("/api/website", () => import("../routes/website.js"))).post("/api/website/contact").set("X-Forwarded-For", nextIp())
      .send({ companyName: "Acme", fullName: "Pat Lee", phone: "+14035550100", email: "pat@acme.test", ...extra }),
    expectTarget: (p) => expect(p[0]).toBe("k1"),
    source: "website_contact_form",
  },
  {
    name: "POST /api/website/credit-readiness",
    send: async (extra) => request(await mount("/api/website", () => import("../routes/website.js"))).post("/api/website/credit-readiness").set("X-Forwarded-For", nextIp())
      .send({ companyName: "Acme", fullName: "Pat Lee", phone: "4035550100", email: "pat@acme.test", ...extra }),
    expectTarget: (p) => {
      expect(p[0]).toBe("pat@acme.test");
      expect(p[4]).toBe("BF");
    },
    source: "website_credit_readiness",
  },
  {
    name: "POST /api/crm/readiness",
    send: async (extra) => request(await mount("/api", () => import("../routes/readiness.js"))).post("/api/crm/readiness")
      .send({ fullName: "Pat Lee", phone: "4035550100", email: "pat@acme.test", ...extra }),
    expectTarget: (p) => expect(p[0]).toBe("k-readiness"),
    source: "readiness_website",
  },
  {
    name: "POST /api/booking",
    send: async (extra) => request(await mount("/api/booking", () => import("../routes/clientBooking.js"))).post("/api/booking")
      .send({ kind: "teams", name: "Pat Lee", email: "pat@acme.test", startsAt: "2026-10-12T15:00:00Z", ...extra }),
    expectTarget: (p) => expect(p[0]).toBe("pat@acme.test"),
    source: "website_booking",
  },
  {
    name: "POST /api/maya/escalate (talk_to_human)",
    send: async (extra) => request(await mount("/api", () => import("../routes/mayaEscalate.js"))).post("/api/maya/escalate").set("X-Forwarded-For", nextIp())
      .send({ kind: "talk_to_human", message: "help", contact: { name: "Pat Lee", phone: "+14035550100" }, ...extra }),
    expectTarget: (p) => expect(p[0]).toBe("k1"),
    source: "maya_escalate",
  },
  {
    name: "POST /api/maya/escalate (report_issue)",
    send: async (extra) => request(await mount("/api", () => import("../routes/mayaEscalate.js"))).post("/api/maya/escalate").set("X-Forwarded-For", nextIp())
      .send({ kind: "report_issue", description: "broken", contact: { name: "Pat Lee", email: "pat@acme.test" }, ...extra }),
    expectTarget: (p) => expect(p[0]).toBe("k1"),
    source: "maya_escalate",
  },
];

beforeEach(() => {
  state.sqls.length = 0;
});

describe.each(cases)("$name", ({ send, expectTarget, source }) => {
  it("casl_consent === true records express consent with its text and time", async () => {
    const r = await send(CONSENT);
    expect(r.status).toBeLessThan(300);
    const writes = consentWrites();
    expect(writes).toHaveLength(1);
    const { sql, params } = writes[0];
    expect(sql).toContain("consent_basis  = 'express'");
    expect(sql).toContain("consent_text   = $4");
    expectTarget(params);
    expect(params[1]).toBe(new Date(CONSENT.casl_consent_at).toISOString());
    expect(params[2]).toBe(source);
    expect(params[3]).toBe(CONSENT.casl_consent_text);
  });

  it("no consent recorded when casl_consent is absent", async () => {
    const r = await send({});
    expect(r.status).toBeLessThan(300);
    expect(consentWrites()).toHaveLength(0);
  });

  it("no consent recorded when casl_consent is false or merely truthy", async () => {
    for (const v of [false, "true", 1]) {
      state.sqls.length = 0;
      const r = await send({ casl_consent: v, casl_consent_text: "x" });
      expect(r.status).toBeLessThan(300);
      expect(consentWrites()).toHaveLength(0);
    }
  });
});

describe("parseExpressCaslConsent", () => {
  it("only an explicit true counts; implausible browser times fall back to the server clock", async () => {
    const { parseExpressCaslConsent } = await import("../services/smsConsent.js");
    const now = new Date("2026-10-11T12:00:00Z");
    expect(parseExpressCaslConsent({}, now)).toBeNull();
    expect(parseExpressCaslConsent({ casl_consent: false }, now)).toBeNull();
    expect(parseExpressCaslConsent({ casl_consent: "true" }, now)).toBeNull();
    expect(parseExpressCaslConsent({ casl_consent: true, casl_consent_at: "2026-10-11T11:59:00Z", casl_consent_text: " ok " }, now))
      .toEqual({ text: "ok", at: new Date("2026-10-11T11:59:00Z") });
    expect(parseExpressCaslConsent({ casl_consent: true, casl_consent_at: "2030-01-01T00:00:00Z" }, now)?.at).toEqual(now);
    expect(parseExpressCaslConsent({ casl_consent: true, casl_consent_at: "garbage" }, now)?.at).toEqual(now);
    expect(parseExpressCaslConsent({ casl_consent: true }, now)?.text).toBeNull();
  });
});
