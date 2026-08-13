// BF_SERVER_INTERNAL_CALLER_v54
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/routes/voiceCalls.ts", "utf8");

describe("resolving a portal-to-portal caller", () => {
  it("recognises the client:<uuid> identity a staff ring arrives as", () => {
    expect(src).toContain('/^client:(.+)$/i.exec(raw.trim())');
  });

  it("looks the caller up in users, not in contacts", () => {
    const branch = src.slice(src.indexOf("clientIdentity"), src.indexOf("const phone10"));
    expect(branch).toContain("FROM users WHERE id::text");
    expect(branch).not.toContain("FROM contacts");
  });

  it("never mines a phone number out of a UUID", () => {
    // A UUID has enough digits to produce a plausible 10-digit number, which
    // matched no contact and surfaced as "Unknown caller" after a nonsense
    // lookup rather than a skipped one.
    expect(src).toContain('const phone10 = clientIdentity ? "" : raw.replace(/[^0-9]/g, "").slice(-10);');
  });

  it("keeps the existing conference-based internal resolution", () => {
    expect(src).toContain("AND c.direction = 'internal'");
  });

  it("still resolves an ordinary inbound number through contacts", () => {
    expect(src).toContain("FROM contacts c");
  });
});
