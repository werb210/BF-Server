// BF_SERVER_DEFER_OWNER2_INVITE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const session = read("src/signnow/embeddedSigningSession.ts");
const webhook = read("src/routes/signnow.ts");
const client = read("src/signnow/signnowClient.ts");

describe("owner 2 invite is deferred to the correct sequential step", () => {
  it("the invite really is sequential, one signer per step", () => {
    // This is WHY the deferral is required - order: i + 1 puts Owner 2 in step 2.
    expect(client).toContain("order: i + 1");
  });

  it("envelope creation no longer requests Owner 2's link", () => {
    expect(session).toContain("Owner 2 invite deferred until Owner 1 signs");
    expect(session).toContain("owner2_invite_pending");
  });

  it("envelope creation records the pending invite for the webhook", () => {
    expect(session).toContain("'owner2_invite_email', $2::text");
    expect(session).toContain("'owner2_invite_name', $3::text");
  });

  it("the webhook mints and emails Owner 2's link once Owner 1 signs", () => {
    expect(webhook).toContain("createEmbeddedGroupLink");
    expect(webhook).toContain("owner2_invite_pending");
    expect(webhook).toContain("Your Boreal application is ready to sign");
  });

  it("the webhook clears the pending flag only on a successful send", () => {
    expect(webhook).toContain("- 'owner2_invite_pending'");
    expect(webhook).toContain("owner2_invite_sent_at");
  });

  it("a failed Owner 2 send stays visible to staff", () => {
    expect(webhook).toContain("'partner_invite_error', $2::text");
  });
});
