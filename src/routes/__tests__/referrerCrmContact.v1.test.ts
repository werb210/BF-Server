// BF_SERVER_REFERRER_CRM_CONTACT_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db.js")>()),
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../modules/referrals/referrerAgreement.service.js", () => ({
  referrerAgreementConfigured: () => false,
  createReferrerAgreementSession: vi.fn(),
  isReferrerAgreementSigned: vi.fn(async () => false),
}));

const SIGNUP = { full_name: "Rita Ref", email: "Rita@Ref.test", phone: "+1 587 555 0100", street: "1 Main", city: "Calgary", province: "AB", postal_code: "T2P 1A1" };
const CONTACT_INSERT = /INSERT INTO contacts/;

async function signup() {
  const { default: router } = await import("../referrerSelf.js");
  const app = express();
  app.use(express.json());
  app.use("/api/referrer", router);
  return request(app).post("/api/referrer/signup").send(SIGNUP);
}

describe("referrer CRM contact + roster hygiene", () => {
  beforeEach(() => queryMock.mockReset());

  it("signup creates a BF CRM contact for the referrer, idempotent by email", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const res = await signup();
    expect(res.status).toBe(200);
    const insert = callsMatching(queryMock, CONTACT_INSERT);
    expect(insert).toHaveLength(1);
    const [sql, params] = insert[0] as [string, unknown[]];
    expect(params.slice(1)).toEqual(["Rita Ref", "Rita@Ref.test", "+1 587 555 0100"]);
    expect(sql).toContain("'BF'");
    expect(sql).toContain("SELECT 1 FROM contacts WHERE silo = 'BF' AND lower(email) = lower($3)");
  });

  it("a failed CRM write never blocks signup", async () => {
    queryMock.mockImplementation(answerBySql([[CONTACT_INSERT, new Error("contacts unavailable")]]));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await signup();
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ agreementConfigured: false });
      expect(err).toHaveBeenCalledWith("referrer_crm_contact_failed", expect.objectContaining({ email: "Rita@Ref.test" }));
    } finally {
      err.mockRestore();
    }
  });

  it("Referrers list excludes the client-submission system user", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const { default: router } = await import("../adminReferrers.js");
    const app = express();
    app.use("/api/admin/referrers", router);
    expect((await request(app).get("/api/admin/referrers").set("Authorization", bearer("Admin"))).status).toBe(200);
    const sql = String(callsMatching(queryMock, /WHERE u\.role = 'Referrer'/)[0]![0]);
    expect(sql).toContain("AND u.id <> '00000000-0000-0000-0000-000000000001'::uuid");
  });
});
