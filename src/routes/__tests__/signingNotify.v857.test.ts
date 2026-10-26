// BF_SERVER_v857_SIGNING_NOTIFY - the routes: Send for signing reports every signer; the partner link route redirects.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  notify: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query, connect: vi.fn(async () => ({ query: h.query, release: vi.fn() })) }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../services/submission/orchestrator.js", () => ({
  readReadinessSnapshot: vi.fn(async () => ({ allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: false, collateralRequired: false, collateralComplete: false })),
}));
vi.mock("../../signnow/sba/sbaTrigger.js", () => ({
  isSbaApplication: vi.fn(async () => false),
  sbaEnvelopeCount: vi.fn(async () => 0),
  sbaFormsComplete: vi.fn(async () => ({ complete: true, missing: [] })),
  startSbaSigningForStaff: vi.fn(),
}));
vi.mock("../../signnow/embeddedSigningSession.js", () => ({ getOrCreateEmbeddedSigningSession: h.session }));
vi.mock("../../signnow/signingNotify.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifySigners: h.notify,
  resolveOwnerSigningLink: h.resolve,
}));

const APP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeee0857";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const SIGNERS = [
  { index: 1, role: "Owner 1", name: "Sean Dwyer", isApplicant: true, alreadySigned: false, waitingFor: null,
    email: { to: "pokedwyer@gmail.com", status: "sent", at: "2026-10-25T22:02:00.000Z", reason: null },
    sms: { to: "(323) 898-2498", status: "sent", at: "2026-10-25T22:02:00.000Z", reason: null } },
];

async function staffApp() {
  const router = (await import("../../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const f of [h.query, h.session, h.notify, h.resolve]) f.mockReset();
  h.query.mockImplementation(answerBySql([
    [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
    [/AS v851_applicant/, { rows: [{ v851_applicant: { firstName: "Sean", lastName: "Dwyer" } }] }],
    [/AS v857_notify FROM applications/, { rows: [{ signnow_app_signed_at: null, embedded: { group_id: "g" }, v857_notify: { at: "2026-10-25T22:02:00.000Z", signers: SIGNERS } }] }],
  ]));
  h.notify.mockResolvedValue({ at: "2026-10-25T22:02:00.000Z", allSigned: false, signers: SIGNERS });
});

describe("v857 POST /api/applications/:id/resend-signing", () => {
  it("builds the session without its own text, then notifies every signer and returns what happened to each", async () => {
    h.session.mockResolvedValue({ status: "ready", url: "https://sign.test/x", expiresAt: null, replaced: true });
    const r = await request(await staffApp()).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send({});
    expect(r.status).toBe(200);
    expect(h.session).toHaveBeenCalledWith(APP_ID, { skipOwner1Notice: true });
    expect(h.notify).toHaveBeenCalledWith(APP_ID);
    expect(r.body.data).toMatchObject({ ok: true, sessionStatus: "ready", replaced: true, signers: SIGNERS });
  });

  it("notifies nobody when the session could not be built, and says why", async () => {
    h.session.mockResolvedValue({ status: "not_ready", reason: "lender_not_finalized" });
    const r = await request(await staffApp()).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send({});
    expect(r.body.data).toMatchObject({ ok: false, reason: "lender_not_finalized", signers: [] });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("the readiness read carries the last notice so the card shows it after a reload", async () => {
    const r = await request(await staffApp()).get(`/api/applications/${APP_ID}/signing-readiness`).set("Authorization", `Bearer ${token()}`);
    expect(r.status).toBe(200);
    expect(r.body.data.signing.notify.signers).toEqual(SIGNERS);
  });
});

describe("v857 GET /api/signing/owner/:token (public)", () => {
  async function publicApp() {
    const router = (await import("../signnow.js")).default;
    const app = express();
    app.use("/api", router);
    return app;
  }

  it("redirects to the fresh SignNow link", async () => {
    h.resolve.mockResolvedValue({ kind: "redirect", url: "https://app.signnow.com/webapp/x" });
    const r = await request(await publicApp()).get("/api/signing/owner/abc");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://app.signnow.com/webapp/x");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(h.resolve).toHaveBeenCalledWith("abc");
  });

  it("shows the page otherwise", async () => {
    h.resolve.mockResolvedValue({ kind: "page", status: 200, html: "<p>Sean Dwyer signs first.</p>" });
    const r = await request(await publicApp()).get("/api/signing/owner/abc");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.text).toContain("Sean Dwyer signs first");
  });
});
