// BF_SERVER_v789_PHONE_LOG_MASK / BF_SERVER_v789_SIGNNOW_LOG
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { maskPhoneLast4, maskPhonesInText } from "../lib/maskPhone.js";

const { queryMock, h } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  h: { findAuthUserByPhone: vi.fn(), verificationCheck: vi.fn(), verificationCreate: vi.fn() },
}));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: queryMock },
  dbQuery: queryMock,
}));
// The OTP handlers' production branches, with Twilio Verify, the DB and the staff lookup faked.
vi.mock("../config/runtime.js", () => ({ isTest: false }));
vi.mock("../middleware/authRateLimit.js", async () => (await import("./helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("./helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: queryMock }));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("maskPhoneLast4 / maskPhonesInText", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhoneLast4("+15558675309")).toBe("***5309");
    expect(maskPhoneLast4("(555) 867-5309")).toBe("***5309");
    expect(maskPhoneLast4("123")).toBe("***");
    expect(maskPhoneLast4(undefined)).toBe("***");
  });

  it("masks a phone echoed inside an error message", () => {
    const out = maskPhonesInText("Invalid parameter `To`: +15558675309 (code 60200)");
    expect(out).not.toContain("5558675309");
    expect(out).toContain("***5309");
    expect(out).toContain("60200");
  });
});

describe("routes/auth.ts OTP logs", () => {
  const RAW = "4035550188";
  const PHONE = "+1" + RAW;

  function spies() {
    return [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
  }
  const allLogged = (s: ReturnType<typeof spies>) => JSON.stringify(s.flatMap((x) => x.mock.calls));

  // Every [otp_verify] branch that logs the phone, driven through the real handler.
  const SCENARIOS: Array<{ name: string; body: Record<string, unknown>; rules: Array<[RegExp, unknown]>; event: string }> = [
    { name: "lender ambiguous", body: { userType: "lender" }, rules: [[/FROM lenders/, { rows: [{ id: "l1" }, { id: "l2" }] }]], event: "lender_login_ambiguous_phone" },
    { name: "lender no match", body: { userType: "lender" }, rules: [], event: "lender_login_no_match" },
    { name: "referrer ambiguous", body: { userType: "referrer" }, rules: [[/FROM users/, { rows: [{ id: "r1" }, { id: "r2" }] }]], event: "referrer_login_ambiguous_phone" },
    { name: "referrer no match", body: { userType: "referrer" }, rules: [], event: "referrer_login_no_match" },
    { name: "referrer pending", body: { userType: "referrer" }, rules: [[/FROM users/, { rows: [{ id: "r1", referrer_status: "pending" }] }]], event: "referrer_login_pending_agreement" },
    { name: "accountant ambiguous", body: { userType: "accountant" }, rules: [[/FROM contacts/, { rows: [{ id: "a1" }, { id: "a2" }] }]], event: "accountant_login_ambiguous_phone" },
    { name: "accountant no match", body: { userType: "accountant" }, rules: [], event: "accountant_login_no_match" },
    { name: "client fallthrough", body: {}, rules: [], event: "client_fallthrough" },
  ];

  for (const sc of SCENARIOS) {
    it(`masks the phone in the ${sc.name} log and never logs the raw number`, async () => {
      vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
      h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
      h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
      queryMock.mockReset().mockImplementation(answerBySql(sc.rules));
      const s = spies();
      const { otpApp } = await import("./helpers/otpVerifyApp.js");
      await request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", ...sc.body });
      const hit = s[0].mock.calls.find((c) => String(c[0]) === `[otp_verify] ${sc.event}`);
      expect(hit, sc.event).toBeDefined();
      expect((hit![1] as { phone: string }).phone).toBe(maskPhoneLast4(PHONE));
      expect(allLogged(s)).not.toContain(RAW);
    });
  }

  it("the OTP start error log masks phones in the provider message", async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    const { _resetOtpGuard } = await import("../lib/otpGuard.js");
    _resetOtpGuard();
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    const providerMessage = `Invalid parameter \`To\`: ${PHONE} (code 60200)`;
    h.verificationCreate.mockReset().mockRejectedValue(new Error(providerMessage));
    const s = spies();
    const { otpApp } = await import("./helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/start").send({ phone: PHONE });
    expect(res.status).toBe(400);
    expect(s[2]).toHaveBeenCalledWith("[error] OTP ERROR:", maskPhonesInText(providerMessage));
    expect(allLogged(s)).not.toContain(RAW);
  });
});

describe("SignNow webhook log", () => {
  const SECRET = "signnow-secret-789";
  async function app() {
    const r = (await import("../routes/signnow.js")).default;
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.use("/api", r);
    return a;
  }

  it("logs only the event type and document ids, never the body", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    queryMock.mockImplementation(answerBySql([]));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = JSON.stringify({
      event: "document.update",
      document_id: "doc-789",
      document_group_id: "grp-789",
      signer_email: "private.person@example.com",
      content: { signer_name: "Jane Private", phone: "+15558675309" },
    });
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
    const res = await request(await app()).post("/api/webhooks/signnow")
      .set("Content-Type", "application/json").set("x-signnow-signature", sig).send(body);
    expect(res.status).toBe(200);

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain("private.person@example.com");
    expect(logged).not.toContain("Jane Private");
    expect(logged).not.toContain("5558675309");
    const received = logSpy.mock.calls.find((c) => String(c[0]).includes("[signnow-webhook] received"));
    expect(received?.[1]).toEqual({ event: "document.update", documentId: "doc-789", documentGroupId: "grp-789" });
  });
});
