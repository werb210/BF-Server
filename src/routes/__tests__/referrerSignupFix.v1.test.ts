// BF_SERVER_REFERRER_SIGNUP_FIX_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "src/routes/referrerSelf.ts"),
  "utf8",
);

describe("referrer signup fix", () => {
  it("inserts status ACTIVE (uppercase) to satisfy users_status_check", () => {
    expect(src).toContain("'ACTIVE', now(), now())");
    expect(src).not.toContain("'active', now(), now())");
  });

  it("returns 409 already_registered on a unique violation, not a 500", () => {
    expect(src).toContain('code === "23505"');
    expect(src).toContain("already_registered");
    expect(src).toContain("res.status(409)");
  });
});
