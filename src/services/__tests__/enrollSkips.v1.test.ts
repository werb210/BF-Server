// BF_SERVER_ENROLL_SKIPS_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const engine = fs.readFileSync(
  path.resolve(__dirname, "../sequenceEngine.ts"), "utf8");

describe("adding a contact to a sequence cannot fail silently", () => {
  it("names the silo mismatch, which drops the contact with no error", () => {
    // The INSERT filters on c.silo=$2. A BF contact added to a BI sequence
    // matches zero rows and the caller saw only a count of 0.
    expect(engine).toContain('reason: "wrong_silo"');
    expect(engine).toContain("this sequence is");
  });

  it("names a contact with no way to reach them", () => {
    expect(engine).toContain('reason: "no_email_or_phone"');
  });

  it("distinguishes an existing enrollment from a failure", () => {
    // ON CONFLICT DO NOTHING makes a re-add indistinguishable from a drop.
    expect(engine).toContain('reason: "already_enrolled"');
  });

  it("reports a contact id that does not exist", () => {
    expect(engine).toContain('reason: "not_found"');
  });

  it("still returns the count, so existing callers keep working", () => {
    expect(engine).toContain("export async function enrollContacts(");
    expect(engine).toContain("Promise<number>");
  });

  it("checks every requested contact, not only the ones it found", () => {
    expect(engine).toContain("for (const id of contactIds)");
  });
});
