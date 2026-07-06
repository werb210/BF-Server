// BF_SERVER_REFERRER_SIGNUP_v1 - referrer self-signup + SignNow agreement gate.
// Signup creates a pending referrer + agreement session; the webhook and the
// verified complete endpoint activate them; OTP login is blocked until active.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const referrer = readFileSync(join(process.cwd(), "src", "routes", "referrerSelf.ts"), "utf-8");
const auth = readFileSync(join(process.cwd(), "src", "routes", "auth.ts"), "utf-8");
const signnow = readFileSync(join(process.cwd(), "src", "routes", "signnow.ts"), "utf-8");
const agreement = readFileSync(join(process.cwd(), "src", "modules", "referrals", "referrerAgreement.service.ts"), "utf-8");
const jwtMod = readFileSync(join(process.cwd(), "src", "auth", "jwt.ts"), "utf-8");

describe("referrer signup", () => {
  it("exposes public /signup and /signup/complete", () => {
    expect(referrer).toContain('"/signup"');
    expect(referrer).toContain('"/signup/complete"');
    expect(referrer).toContain("BF_SERVER_REFERRER_SIGNUP_v1");
  });
  it("requires name/email/phone and full address", () => {
    expect(referrer).toContain("name_email_phone_required");
    expect(referrer).toContain("address_required");
  });
  it("creates the referrer as a pending_agreement users row with role Referrer", () => {
    expect(referrer).toContain("'pending_agreement'");
    expect(referrer).toContain("ROLES.REFERRER");
  });
  it("is idempotent: active -> login, pending -> reuse", () => {
    expect(referrer).toContain("alreadyActive: true");
  });
  it("collects the e-transfer payout email", () => {
    expect(referrer).toContain("etransfer_email");
  });
});

describe("agreement completion is server-verified", () => {
  it("/signup/complete verifies the signature with SignNow before activating", () => {
    expect(referrer).toContain("isReferrerAgreementSigned");
    expect(referrer).toContain("agreement_not_signed");
    expect(referrer).toContain("referrer_status='active'");
  });
  it("mints a referrer token so the signer drops straight in", () => {
    expect(referrer).toContain("signAccessToken");
    expect(referrer).toContain("referrerId: ref.id");
  });
});

describe("agreement service", () => {
  it("is env-gated on API key + template id", () => {
    expect(agreement).toContain("referrerAgreementConfigured");
    expect(agreement).toContain("SIGNNOW_REFERRER_TEMPLATE_ID");
  });
  it("uses the template -> group -> embedded invite -> link pattern", () => {
    expect(agreement).toContain("createDocumentFromTemplate");
    expect(agreement).toContain("createEmbeddedGroupInvite");
    expect(agreement).toContain("createEmbeddedGroupLink");
  });
});

describe("webhook + login gating", () => {
  it("the SignNow webhook activates a referrer when their agreement group signs", () => {
    expect(signnow).toContain("BF_SERVER_REFERRER_SIGNUP_v1");
    expect(signnow).toContain("referrer_status='active'");
    expect(signnow).toContain("agreement_document_group_id");
  });
  it("OTP login refuses referrers whose agreement is not yet signed", () => {
    expect(auth).toContain("referrer_agreement_pending");
    expect(auth).toContain('referrer.referrer_status !== "active"');
  });
});

describe("token type", () => {
  it("AccessTokenPayload carries referrerId", () => {
    expect(jwtMod).toContain("referrerId?: string");
    expect(jwtMod).toContain("payload.referrerId = decoded.referrerId");
  });
});
