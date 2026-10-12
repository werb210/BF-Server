import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
  sendAccountantInvite: vi.fn(),
}));
vi.mock("../config/runtime.js", () => ({ isTest: false }));
vi.mock("../middleware/authRateLimit.js", async () => (await import("./helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("./helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: h.query }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));
vi.mock("../services/accountantInvite.js", () => ({ sendAccountantInvite: h.sendAccountantInvite }));

const APP_ID = "11111111-1111-1111-1111-111111111111";
const EXISTING = { id: "c-acct", first_name: "Old", last_name: "Number", email: "old@firm.test", phone: "4035550100", silo: "BF" };

async function captureApp() {
  const router = (await import("../routes/client/accountant.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/client", router);
  return app;
}

function capture(body: Record<string, unknown> = {}) {
  return captureApp().then((app) =>
    request(app).post("/api/client/accountant").send({
      applicationId: APP_ID,
      firm: "Count & Co",
      contact: "Ada Count",
      email: "ada@count.test",
      phone: "(587) 555-1234",
      ...body,
    }),
  );
}

beforeEach(() => {
  h.query.mockReset();
  h.sendAccountantInvite.mockReset().mockResolvedValue({ sent: true });
  h.query.mockImplementation(answerBySql([
    [/FROM companies/, { rows: [{ id: "co-1", name: "Count & Co", silo: "BF" }] }],
    // find-or-create finds the accountant we already knew, with an old number on file.
    [/FROM contacts\s+WHERE silo = \$1/, { rows: [EXISTING] }],
  ]));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("BF_SERVER_ACCOUNTANT_CONTACT_PHONE_v1", () => {
  it("writes the captured phone so OTP sign-in can match it, without letting a blank erase it", async () => {
    const res = await capture();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contactId: "c-acct" });
    const [update] = callsMatching(h.query, /UPDATE contacts/);
    expect(update).toBeDefined();
    expect(String(update[0])).toContain("phone = COALESCE(NULLIF($3, ''), phone)");
    expect((update[1] as unknown[])[2]).toBe("(587) 555-1234");
  });

  it("writes the captured email too", async () => {
    await capture();
    const [update] = callsMatching(h.query, /UPDATE contacts/);
    expect(String(update[0])).toContain("email = COALESCE(NULLIF($4, ''), email)");
    expect((update[1] as unknown[])[3]).toBe("ada@count.test");
  });

  it("passes the captured values, not just the tag", async () => {
    await capture();
    const [update] = callsMatching(h.query, /UPDATE contacts/);
    expect(update[1]).toEqual(["c-acct", ["Accountant/advisor"], "(587) 555-1234", "ada@count.test"]);
  });

  it("still applies the tag the OTP branch matches on", async () => {
    await capture();
    const [update] = callsMatching(h.query, /UPDATE contacts/);
    expect(String(update[0])).toMatch(/SET tags = /);
    expect((update[1] as unknown[])[1]).toEqual(["Accountant/advisor"]);
  });

  it("guards the reason this was needed: find-or-create does not write the phone", async () => {
    // If this assertion ever fails, find-or-create has started updating the row
    // and the COALESCE above may be redundant - worth rechecking rather than
    // assuming.
    const { findOrCreateContactByEmailAndCompany } = await import("../services/contacts.js");
    const client = { query: h.query } as any;
    const out = await findOrCreateContactByEmailAndCompany(client, "ada@count.test", "co-1", "BF", {
      first_name: "Ada", last_name: "Count", email: "ada@count.test", phone: "5875551234", silo: "BF",
    } as any);
    expect(out).toEqual({ row: EXISTING, created: false });
    expect(callsMatching(h.query, /UPDATE contacts|INSERT INTO contacts/)).toHaveLength(0);
  });

  it("matches the column the OTP branch reads", async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.verificationCheck.mockResolvedValue({ status: "approved" });
    h.query.mockImplementation(answerBySql([[/FROM contacts/, { rows: [{ id: "c-acct" }] }]]));
    const { otpApp } = await import("./helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/verify")
      .send({ phone: "+15875551234", code: "123456", userType: "accountant" });
    expect(res.status).toBe(200);
    const [lookup] = callsMatching(h.query, /FROM contacts/);
    expect(String(lookup[0])).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)");
  });
});
