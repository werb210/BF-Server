// BF_SERVER_v68_OTP_HAS_SUBMISSION
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  poolQuery: vi.fn(),
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
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: h.runQuery }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.poolQuery }, dbQuery: h.poolQuery }));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));

const PHONE = "+14035550188";

async function verify(body: Record<string, unknown> = {}) {
  const { otpApp } = await import("./helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", ...body });
}

beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.runQuery.mockReset().mockImplementation(answerBySql([]));
  h.poolQuery.mockReset().mockImplementation(answerBySql([]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("BF_SERVER_v68_OTP_HAS_SUBMISSION", () => {
  it("OTP verify production response includes hasSubmittedApplication and submittedApplicationId", async () => {
    h.runQuery.mockImplementation(answerBySql([[/FROM applications a/, { rows: [{ id: "app-68" }] }]]));
    const res = await verify();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(["hasSubmittedApplication", "submittedApplicationId", "token"]);
    expect(res.body.data.hasSubmittedApplication).toBe(true);
    expect(res.body.data.submittedApplicationId).toBe("app-68");
    expect(typeof res.body.data.token).toBe("string");
  });

  it("reports no submission when nothing matches", async () => {
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.data.hasSubmittedApplication).toBe(false);
    expect(res.body.data.submittedApplicationId).toBeNull();
  });

  it("runs the lookup through lib/db runQuery, keyed by the verified phone", async () => {
    await verify();
    const lookups = callsMatching(h.runQuery, /FROM applications a/);
    expect(lookups).toHaveLength(1);
    expect(lookups[0][1]).toEqual([PHONE]);
    expect(callsMatching(h.poolQuery, /FROM applications a/)).toHaveLength(0);
  });

  it("submission lookup joins applications + application_contacts + contacts", async () => {
    await verify();
    const sql = String(callsMatching(h.runQuery, /FROM applications a/)[0][0]);
    // BF_SERVER_OTP_LOOKUP_v71 - the INNER JOINs became LEFT JOINs plus a
    // second path through applications.contact_id, because one bad row in
    // application_contacts was enough to bounce a returning client to Step 1.
    expect(sql).toMatch(/LEFT JOIN application_contacts ac/);
    expect(sql).toMatch(/LEFT JOIN contacts c /);
    expect(sql).toMatch(/LEFT JOIN contacts ac2 ON ac2\.id = a\.contact_id/);
    expect(sql).toMatch(/a\.submitted_at IS NOT NULL/);
    expect(sql).toMatch(/ac\.role = 'applicant'/);
    // BF_SERVER_BLOCK_v_OTP_PHONE_NORMALIZED_MATCH_v1 - the lookup matches the
    // last 10 digits of each phone (E.164 login vs as-typed stored), not an exact string.
    expect(sql).toMatch(/right\(regexp_replace\(coalesce\(c\.phone/);
    expect(sql).toMatch(/right\(regexp_replace\(\$1/);
    expect(sql).not.toMatch(/AND c\.phone = \$1/);
  });

  it("OTP verify never fails on a DB hiccup in the submission lookup", async () => {
    h.runQuery.mockImplementation(answerBySql([[/FROM applications a/, new Error("connection reset")]]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await verify();
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.hasSubmittedApplication).toBe(false);
    expect(res.body.data.submittedApplicationId).toBeNull();
    expect(warn).toHaveBeenCalledWith("[otp] submitted-application lookup failed", expect.stringContaining("connection reset"));
  });
});
