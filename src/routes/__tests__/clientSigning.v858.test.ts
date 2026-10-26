// BF_SERVER_v858_PARTNER_SIGNING - GET /api/client/signing-session through the real client router: the signed-in
// owner gets their own link, a waiting notice, "signed", or a refusal. Database faked by SQL content; SignNow and the
// Owner 1 session faked per signer email.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import express from "express";
import request from "supertest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const APP = "5b3c2a10-0000-4000-8000-00000000b858";
const SEAN = { firstName: "Sean", lastName: "Dwyer", email: "sean@pokeprod.test", phone: "5875550141" };
const ELIZ = { firstName: "Elizabeth", lastName: "Cullen", email: "elizabeth@pokeprod.test", phone: "4035550177" };
const GUARANTOR = "2505550100";

const h = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn(), signed: new Set<string>(), mint: vi.fn(), failPeople: false }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../../signnow/embeddedSigningSession.js", async (orig) => ({ ...(await orig<any>()), getOrCreateEmbeddedSigningSession: h.session }));
vi.mock("../../signnow/sendApplicationForSignature.js", async (orig) => ({
  ...(await orig<any>()),
  loadApplicationForPdf: async () => ({ applicantName: "Sean Dwyer", applicantEmail: SEAN.email, owners: [SEAN, ELIZ] }),
}));
vi.mock("../../signnow/sba/sbaTrigger.js", async (orig) => ({ ...(await orig<any>()), isSbaApplication: async () => false }));
vi.mock("../../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<any>()),
  getSignerInviteComplete: async (_g: string, email: string) => h.signed.has(email),
  createEmbeddedGroupLink: (g: string, i: string, email: string) => h.mint(g, i, email),
}));

import clientRouter from "../client/index.js";

const SECRET = "test-secret-v858-partner-signing";
beforeAll(() => { process.env.JWT_SECRET = SECRET; });
const tok = (phone: string) => `Bearer ${jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, SECRET)}`;
const ON_FILE = new Set([SEAN.phone, ELIZ.phone, GUARANTOR]);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/client", clientRouter);
  return a;
}
const get = (phone?: string) => {
  const r = request(app()).get(`/api/client/signing-session?applicationId=${APP}`);
  return phone ? r.set("Authorization", tok(phone)) : r;
};

beforeEach(() => {
  h.signed = new Set();
  h.failPeople = false;
  h.session.mockReset();
  h.session.mockImplementation(async () => ({ status: "ready", url: "https://signnow.test/link/" + SEAN.email, expiresAt: null }));
  h.mint.mockReset();
  h.mint.mockImplementation(async (_g: string, _i: string, email: string) => ({ url: "https://signnow.test/link/" + email, expiresAt: null }));
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    // Not recognised by the router-wide guard, so the signing guard is what answers.
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/SELECT COUNT\(\*\)::int AS mine FROM app_phones/, (_s: string, p?: unknown[]) => ({ rows: [{ mine: p?.[0] === APP && ON_FILE.has(String(p?.[1])) ? 1 : 0 }] })],
    [/AS v858_embedded/, { rows: [{ signnow_app_signed_at: null, v858_embedded: { group_id: "grp-1", invite_id: "inv-1" }, v858_queue: [{ index: 2, email: ELIZ.email }] }] }],
    [/AS v858_role/, () => {
      if (h.failPeople) throw new Error("db down");
      return { rows: [
        { v858_role: "applicant", phone: SEAN.phone, email: SEAN.email },
        { v858_role: "partner", phone: ELIZ.phone, email: ELIZ.email },
        { v858_role: "guarantor", phone: GUARANTOR, email: "guarantor@x.test" },
      ] };
    }],
  ]));
});

describe("v858 client-portal signing session", () => {
  it("needs a signed-in client", async () => {
    const r = await get();
    expect(r.status).toBe(401);
    expect(h.session).not.toHaveBeenCalled();
  });

  it("Sean (Owner 1) gets his own link", async () => {
    const r = await get(SEAN.phone);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ready", url: "https://signnow.test/link/" + SEAN.email, signer: { index: 1, isApplicant: true } });
    expect(h.session).toHaveBeenCalledWith(APP);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("Elizabeth (Owner 2) before Sean signs: waiting for Sean, and never Sean's link", async () => {
    const r = await get(ELIZ.phone);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "not_ready", reason: "waiting_for_signer", waitingFor: "Sean Dwyer", signer: { index: 2, role: "Owner 2", name: "Elizabeth Cullen", isApplicant: false } });
    expect(h.session).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("Elizabeth after Sean signs: her own link, minted for her email", async () => {
    h.signed.add(SEAN.email);
    const r = await get(ELIZ.phone);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ready", url: "https://signnow.test/link/" + ELIZ.email, signer: { index: 2 } });
    expect(h.mint).toHaveBeenCalledWith("grp-1", "inv-1", ELIZ.email);
    expect(JSON.stringify(r.body)).not.toContain(SEAN.email);
    expect(h.session).not.toHaveBeenCalled();
  });

  it("Elizabeth after she signed: signed", async () => {
    h.signed.add(SEAN.email);
    h.signed.add(ELIZ.email);
    const r = await get(ELIZ.phone);
    expect(r.body).toMatchObject({ status: "signed", signer: { index: 2 } });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("someone on the file who is not a signer is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await get(GUARANTOR);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "not_a_signer" });
    expect(h.session).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("a phone not on the file is still refused by the ownership guard", async () => {
    const r = await get("7805550111");
    expect(r.status).toBe(403);
    expect(h.session).not.toHaveBeenCalled();
  });

  it("fails closed, and logs, when the signer check cannot run", async () => {
    h.failPeople = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await get(ELIZ.phone);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "signer_check_failed" });
    expect(h.mint).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
