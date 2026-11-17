// BF_SERVER_v968_PGI_REP_AGREEMENT
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sn = vi.hoisted(() => ({
  isApiKeyConfigured: vi.fn(() => true),
  uploadDocumentWithFieldExtract: vi.fn(async () => ({ documentId: "doc-1" })),
  createDocumentGroup: vi.fn(async () => ({ groupId: "grp-1" })),
  createEmbeddedGroupInvite: vi.fn(async () => ({ inviteId: "inv-1" })),
  createEmbeddedGroupLink: vi.fn(async () => ({ url: "https://sign.example/abc", expiresAt: null })),
  getDocumentGroupStatus: vi.fn(async () => ({ signed: false, summary: "" })),
}));
vi.mock("../signnow/signnowClient.js", () => sn);
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: vi.fn() } }));

import { PGI_REP_AGREEMENT_SECTIONS, buildPgiRepAgreementPdf } from "../signnow/pgiRepAgreementPdfBuilder.js";

const TOKEN = "correct-horse-battery-staple";
async function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/service", (await import("../routes/serviceBridge.js")).default);
  return a;
}
beforeEach(() => { process.env.BACKEND_SERVICE_TOKEN = TOKEN; Object.values(sn).forEach((f) => f.mockClear()); sn.isApiKeyConfigured.mockReturnValue(true); });
afterEach(() => { delete process.env.BACKEND_SERVICE_TOKEN; });

describe("PGI Introducer Agreement wording", () => {
  const all = PGI_REP_AGREEMENT_SECTIONS.flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])]).join("\n");
  it("pays 20% of Boreal's commission, uncapped, only while the agreement is in force", () => {
    expect(all).toMatch(/twenty percent \(20%\) of the commission that Boreal actually receives and retains from the Carrier/);
    expect(all).toMatch(/no cap on the volume/);
    expect(all).toMatch(/When this Agreement ends, for any reason, the Introducer's right to payment ends with it/);
    expect(all).toMatch(/United States dollars by wire or ACH[^.]*within thirty \(30\) days/);
  });
  it("limits the rep to introductions: no selling, quoting or negotiating insurance", () => {
    expect(all).toMatch(/paid for introductions only/);
    expect(all).toMatch(/will not sell, solicit, quote, negotiate, bind or advise on insurance/);
  });
  it("renders a PDF with the rep's details and a signature tag for the Rep role", async () => {
    const pdf = await buildPgiRepAgreementPdf({ fullName: "Alex Tester", email: "alex@example.com", company: "Example Co" });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });
});

describe("issuing the agreement for the insurance server", () => {
  it("needs the service token", async () => {
    const r = await request(await app()).post("/api/service/pgi-rep-agreement").send({ repId: "r1", fullName: "Alex Tester", email: "alex@example.com" });
    expect(r.status).toBe(401);
    expect(sn.uploadDocumentWithFieldExtract).not.toHaveBeenCalled();
  });
  it("uploads the agreement and invites the rep to sign", async () => {
    const r = await request(await app()).post("/api/service/pgi-rep-agreement").set("X-Backend-Token", TOKEN)
      .send({ repId: "r1", fullName: " Alex  Tester ", email: "Alex@Example.com", company: "Example Co" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, groupId: "grp-1", inviteId: "inv-1", documentId: "doc-1" });
    expect(sn.createEmbeddedGroupInvite).toHaveBeenCalledWith("grp-1", ["doc-1"], [{ email: "alex@example.com", name: "Alex Tester", roleName: "Rep" }]);
  });
  it("refuses a missing email, and says so when signing is not set up", async () => {
    const a = await app();
    expect((await request(a).post("/api/service/pgi-rep-agreement").set("X-Backend-Token", TOKEN).send({ repId: "r1", fullName: "Alex" })).status).toBe(400);
    sn.isApiKeyConfigured.mockReturnValue(false);
    expect((await request(a).post("/api/service/pgi-rep-agreement").set("X-Backend-Token", TOKEN).send({ repId: "r1", fullName: "Alex", email: "a@example.com" })).status).toBe(503);
  });
  it("gives a fresh signing link until it is signed, then reports signed", async () => {
    const a = await app();
    const link = await request(a).post("/api/service/pgi-rep-agreement/link").set("X-Backend-Token", TOKEN).send({ groupId: "grp-1", inviteId: "inv-1", email: "alex@example.com" });
    expect(link.body).toEqual({ ok: true, signed: false, url: "https://sign.example/abc" });
    sn.getDocumentGroupStatus.mockResolvedValue({ signed: true, summary: "" });
    expect((await request(a).post("/api/service/pgi-rep-agreement/link").set("X-Backend-Token", TOKEN).send({ groupId: "grp-1", inviteId: "inv-1", email: "alex@example.com" })).body).toEqual({ ok: true, signed: true, url: null });
    expect((await request(a).get("/api/service/pgi-rep-agreement/grp-1/status").set("X-Backend-Token", TOKEN)).body).toEqual({ ok: true, signed: true });
  });
});
