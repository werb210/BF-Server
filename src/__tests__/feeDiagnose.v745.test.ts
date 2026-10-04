// BF_SERVER_FEE_DIAGNOSE_v745
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const rows = vi.hoisted(() => ({ app: null as any, texts: [] as any[] }));
vi.mock("../db.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM applications")) return { rows: rows.app ? [rows.app] : [] };
    if (sql.includes("FROM sms_deliveries")) return { rows: rows.texts };
    return { rows: [] };
  }),
}));
vi.mock("../signnow/signnowClient.js", () => ({ isApiKeyConfigured: () => true }));
import { diagnoseFeeAgreement } from "../routes/portalFeeAgreement.js";

beforeEach(() => {
  process.env.TWILIO_PHONE = "+15875550199"; process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.TWILIO_AUTH_TOKEN = "t";
  process.env.SENDGRID_API_KEY = "k"; process.env.SENDGRID_FROM = "a@b.ca"; delete process.env.TEST_MODE;
  rows.texts = [];
});

describe("fee agreement diagnosis", () => {
  it("names a carrier rejection with its Twilio error code", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", phone: "403-555-0100", email: "d@x.ca" } } };
    rows.texts = [{ to_number: "+14035550100", status: "undelivered", error_code: "30032", created_at: "2026-10-04T20:00:00Z" }];
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d.ok).toBe(false);
    expect(d.problems.join(" ")).toContain("text to mobile ending 0100 was undelivered (Twilio error 30032)");
    expect(d.sendingNumberLast4).toBe("0199");
  });
  it("reports a missing mobile, a missing sending number and TEST_MODE", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", email: "d@x.ca" } } };
    delete process.env.TWILIO_PHONE; process.env.TEST_MODE = "true";
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d.problems).toEqual(expect.arrayContaining([
      "no usable mobile number for the signer on this application",
      "no Twilio sending number set on the server (TWILIO_PHONE)",
      "server is in TEST_MODE - texts are skipped",
    ]));
  });
  it("is clean when everything is set", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", phone: "4035550100", email: "d@x.ca" } } };
    rows.texts = [{ to_number: "+14035550100", status: "delivered", error_code: null, created_at: "x" }];
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d).toMatchObject({ ok: true, problems: [] });
  });
  it("the client signing window now receives the real failure reason", () => {
    const s = readFileSync("src/routes/client/index.ts", "utf8");
    expect(s).toContain('reason: "session_failed: " + (e instanceof Error ? e.message : String(e)).slice(0, 200)');
  });
});
