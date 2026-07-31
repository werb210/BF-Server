import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAccountantInvite } from "../services/accountantInvite.js";

const route = readFileSync(fileURLToPath(new URL("../routes/client/accountant.ts", import.meta.url)), "utf-8");
const service = readFileSync(fileURLToPath(new URL("../services/accountantInvite.js", import.meta.url).href.replace(".js", ".ts")), "utf-8");

const base = {
  accountantName: "Dana Reid",
  accountantPhone: "+15875551234",
  applicantName: "Sam Carter",
  businessName: "Carter Haulage Ltd.",
  portalLink: "https://client.boreal.financial/accountant",
};

describe("BF_SERVER_ACCOUNTANT_INVITE_v1 copy", () => {
  it("names the business in the subject", () => {
    const { subject } = buildAccountantInvite(base);
    expect(subject).toContain("Carter Haulage Ltd.");
    expect(subject).toContain("sent at your client's request");
  });

  it("asks the accountant to confirm with the applicant", () => {
    const { html } = buildAccountantInvite(base);
    expect(html).toContain("Sam Carter");
    expect(html).toContain("authorised to release these documents");
  });

  it("tells them which number to sign in with", () => {
    const { html } = buildAccountantInvite(base);
    expect(html).toContain("+15875551234");
    expect(html).toContain("one-time code");
  });

  it("links the portal", () => {
    const { html } = buildAccountantInvite(base);
    expect(html).toContain('href="https://client.boreal.financial/accountant"');
  });

  it("offers the phone line only when there is a number to offer", () => {
    expect(buildAccountantInvite({ ...base, supportPhone: "+17802648467" }).html).toContain("call us at +17802648467");
    const withoutPhone = buildAccountantInvite(base).html;
    expect(withoutPhone).toContain("just reply to this email");
    expect(withoutPhone).not.toContain("call us at");
  });

  it("escapes names so a quote in a business name cannot break the markup", () => {
    const { html } = buildAccountantInvite({ ...base, businessName: 'Bob & "Sons" <Ltd>' });
    expect(html).toContain("Bob &amp; &quot;Sons&quot; &lt;Ltd&gt;");
    expect(html).not.toContain("<Ltd>");
  });
});

describe("BF_SERVER_ACCOUNTANT_INVITE_v1 delivery", () => {
  it("claims the slot before sending so a repeat capture cannot re-email", () => {
    expect(service).toContain("ON CONFLICT (application_id, contact_id) DO NOTHING");
    expect(service).toContain("already_invited");
  });

  it("releases the claim when the send fails, so a retry is possible", () => {
    expect(service).toContain("DELETE FROM accountant_invites");
    expect(service).toContain("sent_at IS NULL");
  });

  it("never holds up the wizard response", () => {
    expect(route).toContain("void (async () => {");
    expect(route).toContain("invite not sent");
  });
});
