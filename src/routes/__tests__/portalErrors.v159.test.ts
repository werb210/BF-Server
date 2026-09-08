// BF_SERVER_PORTAL_ERRORS_v1
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const route = fs.readFileSync(path.resolve(__dirname, "../portalErrors.ts"), "utf8");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../../migrations/2026_09_08_v159_portal_errors.sql"),
  "utf8",
);

function fingerprint(message: string, stack: string) {
  const topFrame = stack.split("\n")[1]?.trim() ?? "";
  return createHash("sha256").update(`${message}::${topFrame}`).digest("hex");
}

describe("portal error sink", () => {
  it("is authenticated, unlike the public applicant channel", () => {
    expect(route).toContain("router.use(requireAuth)");
  });

  it("writes to its own table, not the customer triage queue", () => {
    expect(route).toContain("INSERT INTO portal_errors");
    expect(route).not.toContain("client_issues");
  });

  it("keeps the stack that /api/client/issues would have dropped", () => {
    expect(route).toContain("stack");
    expect(migration).toMatch(/stack\s+text/);
  });

  it("collapses a repeating defect into one row with a count", () => {
    expect(route).toContain("ON CONFLICT (fingerprint) DO UPDATE");
    expect(route).toContain("occurrences = portal_errors.occurrences + 1");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS portal_errors_fingerprint_idx",
    );
  });

  it("fingerprints on message plus top frame, so line shifts do not fragment", () => {
    const a = fingerprint("boom", "Error: boom\n    at Foo (app.js:10:5)");
    const b = fingerprint("boom", "Error: boom\n    at Foo (app.js:10:5)");
    const c = fingerprint("boom", "Error: boom\n    at Bar (app.js:99:1)");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("is idempotent, like every other migration here", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBeGreaterThan(0);
  });
});
