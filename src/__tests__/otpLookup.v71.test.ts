// BF_SERVER_OTP_LOOKUP_v71 - a returning client whose application_contacts row
// pointed at the wrong contact was sent back to Step 1 of a form they had
// already finished, with nothing in the logs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
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

async function lookupSql(): Promise<string> {
  const { otpApp } = await import("./helpers/otpVerifyApp.js");
  const res = await request(await otpApp()).post("/api/auth/otp/verify").send({ phone: "+14035550188", code: "123456" });
  expect(res.status).toBe(200);
  const [call] = callsMatching(h.query, /FROM applications a/);
  expect(call).toBeDefined();
  return String(call[0]);
}

beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the lookup no longer depends on one join", () => {
  it("consults applications.contact_id as well", async () => {
    expect(await lookupSql()).toContain("LEFT JOIN contacts ac2 ON ac2.id = a.contact_id");
  });

  it("matches on either contact's phone", async () => {
    expect(await lookupSql()).toContain("OR right(regexp_replace(coalesce(ac2.phone, '')");
  });

  it("no longer INNER JOINs through the join table", async () => {
    expect(await lookupSql()).not.toContain("INNER JOIN application_contacts ac ON ac.application_id = a.id");
  });

  it("keeps the applicant-role filter on the join it still uses", async () => {
    expect(await lookupSql()).toContain("ON ac.application_id = a.id AND ac.role = 'applicant'");
  });

  it("a match through applications.contact_id alone routes the client to their application", async () => {
    // The database answers the lookup as it would when only ac2 matched.
    h.query.mockImplementation(answerBySql([[/LEFT JOIN contacts ac2 ON ac2\.id = a\.contact_id/, { rows: [{ id: "app-71" }] }]]));
    const { otpApp } = await import("./helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/verify").send({ phone: "+14035550188", code: "123456" });
    expect(res.body.data).toMatchObject({ hasSubmittedApplication: true, submittedApplicationId: "app-71" });
  });
});

describe("it still only finds submitted applications", () => {
  it("requires submitted_at", async () => {
    expect(await lookupSql()).toContain("WHERE a.submitted_at IS NOT NULL");
  });

  it("still needs at least ten digits to compare", async () => {
    expect(await lookupSql()).toContain("length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10");
  });
});

describe("a failure is visible", () => {
  it("logs rather than degrading silently", async () => {
    h.query.mockImplementation(answerBySql([[/FROM applications a/, new Error("relation missing")]]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { otpApp } = await import("./helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/verify").send({ phone: "+14035550188", code: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.data.hasSubmittedApplication).toBe(false);
    expect(warn).toHaveBeenCalledWith("[otp] submitted-application lookup failed", expect.stringContaining("relation missing"));
  });
});
