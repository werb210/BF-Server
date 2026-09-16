// BF_SERVER_SHARED_MAILBOX_DIAGNOSTIC_v291
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { sharedMailboxReason, shouldLogSharedFailure, tokenIdentity } from "../tokenIdentity.js";

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("reading the connected account and permissions from the token", () => {
  it("finds the account and the shared-mailbox permission", () => {
    const id = tokenIdentity(jwt({ upn: "todd.w@Boreal.financial", scp: "User.Read Mail.ReadWrite Mail.Read.Shared" }));
    expect(id).toEqual({ account: "todd.w@Boreal.financial", scopes: ["User.Read", "Mail.ReadWrite", "Mail.Read.Shared"], hasSharedMailboxScope: true });
  });
  it("spots a token without the shared-mailbox permission", () => {
    const id = tokenIdentity(jwt({ upn: "todd.w@Boreal.financial", scp: "User.Read Mail.ReadWrite Mail.Send" }));
    expect(id.hasSharedMailboxScope).toBe(false);
    expect(sharedMailboxReason("info@boreal.financial", id)).toContain("without permission to read shared mailboxes");
  });
  it("names the account when the permission is there but access is not", () => {
    const id = tokenIdentity(jwt({ upn: "todd.w@canadianbusinessfinancing.com", scp: "Mail.Read.Shared" }));
    expect(sharedMailboxReason("info@boreal.financial", id)).toContain("todd.w@canadianbusinessfinancing.com cannot open info@boreal.financial");
  });
  it("never throws on an unreadable token", () => {
    expect(tokenIdentity("not-a-jwt")).toEqual({ account: null, scopes: [], hasSharedMailboxScope: false });
  });
});

describe("log rate", () => {
  it("logs a failing mailbox at most once every 10 minutes per user", () => {
    expect(shouldLogSharedFailure("u1", "info@x", 0 + 1e12)).toBe(true);
    expect(shouldLogSharedFailure("u1", "INFO@x", 1e12 + 20_000)).toBe(false);
    expect(shouldLogSharedFailure("u1", "accounting@x", 1e12 + 20_000)).toBe(true);
    expect(shouldLogSharedFailure("u1", "info@x", 1e12 + 11 * 60_000)).toBe(true);
  });
  it("is wired into the inbox route", () => {
    const inbox = fs.readFileSync("src/routes/crm/inbox.ts", "utf8");
    expect(inbox).toContain('event: "o365_shared_mailbox_failed"');
    expect(inbox).toContain("signedInAs: identity.account");
  });
});
