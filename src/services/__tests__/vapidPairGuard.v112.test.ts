// BF_SERVER_VAPID_PAIR_GUARD_v112
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "pushService.ts"), "utf-8");

describe("VAPID pair guard", () => {
  it("checks the pair at startup", () => {
    expect(src).toContain("assertVapidPairMatches(publicKey, privateKey)");
  });

  it("names the fix in the error, not just the symptom", () => {
    expect(src).toContain("push_vapid_pair_mismatch");
    expect(src).toContain("web-push generate-vapid-keys");
  });

  it("logs success too, so a healthy pair is visible in the boot log", () => {
    expect(src).toContain("push_vapid_pair_ok");
  });

  it("never blocks push startup on a diagnostic failure", () => {
    expect(src).toContain("push_vapid_pair_check_failed");
  });

  it("still treats 403 as terminal for the subscription", () => {
    expect(src).toContain("statusCode === 403");
  });
});
