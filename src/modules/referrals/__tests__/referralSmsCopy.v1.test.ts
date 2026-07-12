import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { referralIntroBody, REFERRAL_SMS_VERSIONS } from "../referralInvite.js";

describe("BF_SERVER_REFERRAL_SMS_COPY_v1", () => {
  const url = "https://www.boreal.financial/r/f/ABC123";

  it("never sends the bare version key as the message body", () => {
    const a = referralIntroBody({ message: "A", referrerName: "Todd Werboweski", url });
    const b = referralIntroBody({ message: "B", referrerName: "Todd Werboweski", url });
    expect(a.split("\n")[0]).not.toBe("A");
    expect(b.split("\n")[0]).not.toBe("B");
    expect(a).toContain(url);
    expect(b).toContain(url);
  });

  it("version A includes the referrer name, version B does not", () => {
    const a = referralIntroBody({ message: "A", referrerName: "Todd Werboweski", url });
    const b = referralIntroBody({ message: "B", referrerName: "Todd Werboweski", url });
    expect(a).toContain("Todd Werboweski");
    expect(b).not.toContain("Todd Werboweski");
  });

  it("falls back to the nameless A copy when the referrer has no name", () => {
    expect(REFERRAL_SMS_VERSIONS.A(null)).not.toContain("null");
    expect(referralIntroBody({ message: "A", referrerName: null, url })).toContain(url);
  });

  it("treats anything that is not A or B as custom copy", () => {
    const out = referralIntroBody({ message: "Custom note here", referrerName: "Todd", url });
    expect(out).toBe(`Custom note here\n${url}`);
  });

  it("persists the full referrer profile field set", () => {
    const src = readFileSync(path.join(process.cwd(), "src/routes/referrerSelf.ts"), "utf8");
    expect(src).toContain("BF_SERVER_REFERRER_PROFILE_FULL_v1");
    for (const col of ["street", "city", "province", "postal_code", "etransfer_email"]) {
      expect(src).toContain(`${col} = COALESCE(`);
    }
  });
});
