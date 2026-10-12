// BF_SERVER_BROKER_SIGNUP_v717
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { pdfContent } from "./helpers/pdfContent.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), uploads: [] as Array<{ pdf: Uint8Array; name: string }> }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../signnow/signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: async (pdf: Uint8Array, name: string) => { h.uploads.push({ pdf, name }); return { documentId: "doc-1" }; },
  createDocumentGroup: async () => ({ groupId: "grp-1" }),
  createEmbeddedGroupInvite: async () => ({ inviteId: "inv-1" }),
  createEmbeddedGroupLink: async () => ({ url: "https://signnow.test/sign/grp-1" }),
  getDocumentGroupStatus: async () => ({ signed: false }),
}));

import { buildBrokerAgreementPdf } from "../signnow/brokerAgreementPdfBuilder.js";
import referrerSelfRouter from "../routes/referrerSelf.js";

const app = express();
app.use(express.json());
app.use("/api/referrer", referrerSelfRouter);
const SIGNUP = { full_name: "Bea Broker", email: "bea@brokerage.test", phone: "+15875550142", street: "1 Main St", city: "Calgary", province: "AB", postal_code: "T2P 1A1", company_name: "Brokerage Inc" };

beforeEach(() => {
  h.uploads.length = 0;
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
});

describe("broker sign-up", () => {
  it("the broker link signs up with kind broker and signs the broker agreement", async () => {
    const r = await request(app).post("/api/referrer/signup").send({ ...SIGNUP, kind: "broker" });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ agreementConfigured: true, signingUrl: "https://signnow.test/sign/grp-1", groupId: "grp-1" });
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].name).toMatch(/^Boreal Broker Agreement - Brokerage Inc - /);
    const partner = callsMatching(h.queryMock, /partner_kind = 'broker'/);
    expect(partner).toHaveLength(1);
    expect(partner[0][1]).toEqual([r.body.data.referrerId]);
  });

  it("a broker must name the brokerage", async () => {
    const { company_name: _omit, ...noCompany } = SIGNUP;
    const r = await request(app).post("/api/referrer/signup").send({ ...noCompany, kind: "broker" });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("brokerage_name_required");
  });

  it("without kind broker the referral agreement is signed instead", async () => {
    const r = await request(app).post("/api/referrer/signup").send(SIGNUP);
    expect(r.status).toBe(201);
    expect(h.uploads[0].name).toMatch(/^Boreal Referral Agreement - Bea Broker - /);
    expect(callsMatching(h.queryMock, /partner_kind/)).toHaveLength(0);
  });

  it("builds the broker agreement PDF with a signature field", async () => {
    const pdf = await buildBrokerAgreementPdf({ fullName: "A B", company: "Brokerage Inc", email: "a@b.com" });
    expect(pdf.length).toBeGreaterThan(5000);
    const { runs, text } = pdfContent(pdf);
    expect(runs.some((run) => run.text.startsWith("{{t:s;r:y;"))).toBe(true);
    expect(text).toContain("Brokerage Inc");
  });
});
