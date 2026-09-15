// BF_SERVER_CLIENT_EMAIL_RESOLVER_v194
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const resolver = readFileSync("src/services/clientEmail.ts", "utf-8");
const rejection = readFileSync("src/services/rejectionNotice.ts", "utf-8");
const hold = readFileSync("src/services/holdNotice.ts", "utf-8");

describe("client email resolver", () => {
  it("reads both the contact column and the applicant metadata", () => {
    expect(resolver).toContain("c.email AS contact_email");
    expect(resolver).toMatch(/metadata->'applicant'/);
    expect(resolver).toMatch(/metadata->'borrower'/);
  });

  it("prefers the CRM contact when it has an address", () => {
    const contactBranch = resolver.indexOf('source: "contact"');
    const metadataBranch = resolver.indexOf('source: "applicant_metadata"');
    expect(contactBranch).toBeGreaterThan(-1);
    expect(contactBranch).toBeLessThan(metadataBranch);
  });

  it("accepts the camelCase and snake_case spellings the wizard writes", () => {
    expect(resolver).toMatch(/applicant\.email \?\? applicant\.emailAddress \?\? applicant\.email_address/);
  });

  it("never falls back to a partner or co-owner address", () => {
    expect(resolver).not.toMatch(/partner/i);
    expect(resolver).not.toMatch(/coOwner|co_owner/i);
  });

  it("cannot throw and take a notice down with it", () => {
    expect(resolver).toContain(".catch(() => ({ rows: [] as any[] }))");
  });
});

describe("notices use the resolver", () => {
  it("rejection notice no longer has its own contacts lookup", () => {
    expect(rejection).toContain("resolveClientEmail(applicationId)");
    expect(rejection).not.toMatch(/LEFT JOIN contacts co ON co\.id = a\.contact_id/);
  });

  it("hold notice uses it too", () => {
    expect(hold).toContain("resolveClientEmail(applicationId)");
  });

  it("a failed rejection send releases the one-shot attempt", () => {
    expect(rejection).toMatch(/releaseAttempt\("no_client_email"\)/);
    expect(rejection).toMatch(/releaseAttempt\("no_reasons"\)/);
  });

  it("but a genuine prior send is never released", () => {
    const i = rejection.indexOf("already_sent");
    expect(rejection.slice(i - 200, i + 120)).not.toContain("releaseAttempt");
  });
});
