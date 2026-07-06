// BF_SERVER_SENDGRID_DIAGNOSTICS_v1 - the admin "test SendGrid now" endpoint
// reports config state and, given a `to`, returns SendGrid's exact status +
// a plain-language diagnosis (401=bad key, 403=sender not verified).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const admin = readFileSync(join(process.cwd(), "src", "routes", "admin.ts"), "utf-8");

describe("sendgrid diagnostics endpoint", () => {
  it("is registered, admin-guarded, and sentinel-marked", () => {
    expect(admin).toContain("BF_SERVER_SENDGRID_DIAGNOSTICS_v1");
    expect(admin).toContain('"/sendgrid-diagnostics"');
    expect(admin).toContain("requireCapability([CAPABILITIES.USER_MANAGE])");
  });
  it("reports config state without leaking the full key", () => {
    expect(admin).toContain("keySet");
    expect(admin).toContain("fromSet");
    expect(admin).toContain('slice(0, 3)');
    expect(admin).toContain('keyLooksValid: keyPrefix === "SG."');
  });
  it("does a real send and maps status to a plain diagnosis", () => {
    expect(admin).toContain("await sendOne(");
    expect(admin).toContain('diagnosis = "api_key_invalid"');
    expect(admin).toContain('diagnosis = "sender_not_verified_or_forbidden"');
    expect(admin).toContain("sendStatus: r.status");
  });
});
