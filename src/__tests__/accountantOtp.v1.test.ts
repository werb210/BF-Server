import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readAccountantIdentity } from "../middleware/requireAccountant.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
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

const SECRET = "test-secret-for-accountant-tokens";
const PHONE = "+15875551234";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function reqWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function verifyAccountant(rows: unknown[]) {
  h.query.mockImplementation(answerBySql([[/FROM contacts/, { rows }]]));
  const { otpApp } = await import("./helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", userType: "accountant" });
}

describe("BF_SERVER_ACCOUNTANT_OTP_v1 login branch", () => {
  const original = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = original; });
  beforeEach(() => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.query.mockReset();
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("matches on the accountant tag the capture flows write, in the BF silo", async () => {
    const res = await verifyAccountant([{ id: "c-1", first_name: "Ada", last_name: "Count" }]);
    expect(res.status).toBe(200);
    const [lookup] = callsMatching(h.query, /FROM contacts/);
    expect(String(lookup[0])).toContain("'Accountant/advisor' = ANY(COALESCE(tags, '{}'::text[]))");
    expect(String(lookup[0])).toContain("silo = 'BF'");
    expect(lookup[1]).toEqual([PHONE]);
  });

  it("refuses a shared phone rather than picking one", async () => {
    const res = await verifyAccountant([{ id: "c-1" }, { id: "c-2" }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ambiguous_accountant_phone");
    expect(res.body.data).toBeUndefined();
  });

  it("refuses a phone with no accountant behind it", async () => {
    const res = await verifyAccountant([]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_accountant_for_phone");
  });

  it("binds the token to the contact, not an application, with the accountant role", async () => {
    const res = await verifyAccountant([{ id: "c-1", first_name: "Ada", last_name: "Count" }]);
    expect(res.status).toBe(200);
    const claims = jwt.verify(res.body.data.token, SECRET) as Record<string, any>;
    expect(claims.contactId).toBe("c-1");
    expect(claims.applicationId).toBeUndefined();
    // Outside the staff role set: lowercase "accountant" is never a staff role.
    expect(claims.role).toBe("accountant");
    expect(res.body.data.user).toEqual({ id: "c-1", name: "Ada Count", phone: PHONE, userType: "accountant" });
    // The issued token passes the accountant guard.
    expect(readAccountantIdentity(reqWith(res.body.data.token))).toEqual({ contactId: "c-1", phone: PHONE });
  });

  it("expires sooner than the client token (7 days)", async () => {
    const res = await verifyAccountant([{ id: "c-1" }]);
    const claims = jwt.decode(res.body.data.token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);
  });
});

describe("BF_SERVER_ACCOUNTANT_OTP_v1 guard", () => {
  const original = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = original; });

  it("accepts a well-formed accountant token", () => {
    const token = jwt.sign({ role: "accountant", contactId: "c-1", phone: "+15875551234" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toEqual({ contactId: "c-1", phone: "+15875551234" });
  });

  it("rejects a token with the role but no contact binding", () => {
    const token = jwt.sign({ role: "accountant" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a staff token", () => {
    const token = jwt.sign({ role: "Admin", contactId: "c-1" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = jwt.sign({ role: "accountant", contactId: "c-1" }, "some-other-secret");
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a missing header", () => {
    expect(readAccountantIdentity({ headers: {} } as any)).toBeNull();
  });
});
