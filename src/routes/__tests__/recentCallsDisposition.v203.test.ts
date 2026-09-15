// BF_SERVER_RECENT_CALLS_DISPOSITION_v203
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/voiceCalls.ts", "utf-8");
const ref = readFileSync("src/modules/calls/callRef.ts", "utf-8");

describe("recent calls feed", () => {
  it("returns the disposition so an outcome already set is visible", () => {
    expect(src).toContain("cl.disposition,");
    expect(src).toMatch(/SELECT id, direction, status, duration_seconds, created_at, phone_number, contact_id, contact_name, disposition/);
  });

  it("returns cl.id, which is the reference the disposition endpoint matches", () => {
    expect(src).toContain("cl.id::text AS id");
    expect(ref).toContain('if (UUID_RE.test(value)) return { kind: "id", value };');
  });

  it("reads call_logs directly, so no conferences join is involved", () => {
    // conferences has no link to call_logs; that mismatch is why the contact
    // call feed cannot host this control.
    const block = src.slice(src.indexOf('\"/recent-calls\"'), src.indexOf('\"/recent-calls\"') + 2000);
    expect(block).toContain("FROM call_logs cl");
    expect(block).not.toContain("conferences");
  });
});
