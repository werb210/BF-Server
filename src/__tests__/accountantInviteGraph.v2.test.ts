import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAccountantInvite } from "../services/accountantInvite.js";

const service = readFileSync(fileURLToPath(new URL("../services/accountantInvite.ts", import.meta.url)), "utf-8");
const route = readFileSync(fileURLToPath(new URL("../routes/client/accountant.ts", import.meta.url)), "utf-8");
const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/2026_08_01_v2834_accountant_invites_contact_uuid.sql", import.meta.url)),
  "utf-8",
);

describe("BF_SERVER_ACCOUNTANT_INVITE_GRAPH_v2 channel", () => {
  it("sends through the tenant mailbox, not the bulk ESP", () => {
    expect(service).toContain("sendViaGraph");
    expect(service).not.toContain("sendTransactional");
    expect(service).not.toContain("sendgridConfigured");
  });

  it("carries a plain-text alternative", () => {
    // HTML-only mail is stripped or binned by some corporate filters, and an
    // accountant on a locked-down Exchange tenant is exactly that case.
    expect(service).toContain("bodyText");
    expect(service).toContain("bodyHtml: html");
  });

  it("puts the portal link in the plain-text body too", () => {
    expect(service).toContain("${portalBase}/accountant");
  });
});

describe("BF_SERVER_ACCOUNTANT_INVITE_GRAPH_v2 schema", () => {
  it("corrects contact_id to uuid so the sent_at stamp can run", () => {
    expect(migration).toContain("ALTER COLUMN contact_id TYPE uuid");
  });

  it("only alters the column when it is still text", () => {
    expect(migration).toContain("AND data_type = 'text'");
  });
});

describe("BF_SERVER_ACCOUNTANT_INVITE_GRAPH_v2 visibility", () => {
  it("logs the capture, not only its failures", () => {
    expect(route).toContain('"[client.accountant] captured"');
  });

  it("logs a successful send", () => {
    expect(route).toContain('"[client.accountant] invite sent"');
  });

  it("still logs a failed send", () => {
    expect(route).toContain("invite not sent");
  });
});

describe("BF_SERVER_ACCOUNTANT_INVITE_GRAPH_v2 copy", () => {
  const base = {
    accountantName: "Dana Reid",
    accountantPhone: "+15875551234",
    applicantName: "Sam Carter",
    businessName: "Carter Haulage Ltd.",
    portalLink: "https://client.boreal.financial/accountant",
  };

  it("still renders the approved wording", () => {
    const { subject, html } = buildAccountantInvite(base);
    expect(subject).toContain("Carter Haulage Ltd.");
    expect(html).toContain("authorised to release these documents");
    expect(html).toContain("+15875551234");
  });
});
