// BF_SERVER_REFERRER_SIGNUP_PROFILE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "src/routes/referrerSelf.ts"),
  "utf8",
);

describe("referrer signup sets profile_complete", () => {
  it("INSERT includes profile_complete column and true value", () => {
    expect(src).toContain("active, status, profile_complete, created_at, updated_at");
    expect(src).toContain("'pending_agreement', true, 'ACTIVE', true, now(), now())");
  });

  it("UPDATE sets profile_complete=true", () => {
    expect(src).toContain("profile_complete=true, updated_at=now()");
  });
});
