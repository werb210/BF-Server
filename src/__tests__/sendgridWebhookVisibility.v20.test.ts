// BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const hook = fs.readFileSync(path.resolve(__dirname, "../routes/sendgridWebhook.ts"), "utf8");
const app = fs.readFileSync(path.resolve(__dirname, "../app.ts"), "utf8");

describe("sendgrid webhook visibility", () => {
  it("logs a rejection with the three things that distinguish the causes", () => {
    expect(hook).toContain("REJECTED 403 signature verification failed");
    expect(hook).toContain("signatureHeaderPresent");
    expect(hook).toContain("rawBodyFromVerifyHook");
  });

  it("logs an accepted batch so a passing test is visible too", () => {
    expect(hook).toContain('console.log("[sendgrid-webhook] accepted"');
    expect(hook).toContain("contactsResolved: resolved");
  });

  // BF_SERVER_v784_WEBHOOK_SIGNATURES - an unset key now rejects instead of accepting unsigned posts.
  it("logs and rejects when the key is unset", () => {
    expect(hook).toContain("SENDGRID_WEBHOOK_PUBLIC_KEY unset - rejecting");
    expect(hook).not.toContain("accepting unsigned posts");
  });

  it("never logs the key or the signature themselves", () => {
    expect(hook).not.toMatch(/console\.(log|error|warn)\([^)]*signature:\s*sig/);
    expect(hook).toContain("keyLength:");
  });

  it("still relies on rawBody captured by the global json verify hook", () => {
    expect(app).toContain("rawBody = buf");
  });
});
