import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const src = readFileSync(fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)), "utf-8");
describe("email template landing url", () => {
  it("creates a landing page for email templates and returns landingUrl", () => {
    expect(src).toContain("BF_SERVER_EMAIL_TEMPLATE_LANDING_v1");
    expect(src).toContain('channel === "email" && b.html');
    expect(src).toContain("saved: true, landingUrl");
  });
});
