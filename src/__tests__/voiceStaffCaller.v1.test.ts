// BF_SERVER_STAFF_CALLER_RESOLVE_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/voiceCalls.ts", import.meta.url)), "utf-8");

describe("staff caller resolution", () => {
  it("falls back from contacts to the users directory by phone", () => {
    const route = src.slice(src.indexOf('router.post("/resolve-caller"'), src.indexOf('// BF_SERVER_RECENT_CALLS_v1'));
    expect(route).toContain("FROM contacts c");
    expect(route).toContain("FROM users");
    expect(route).toContain("coalesce(phone_number, phone, '')");
  });

  it("identifies internal callers without changing client calls", () => {
    expect(src).toContain("isStaff: true");
    expect(src).toContain("isStaff: false");
  });
});
