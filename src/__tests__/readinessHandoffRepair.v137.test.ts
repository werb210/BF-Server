// BF_SERVER_BLOCK_v137_READINESS_HANDOFF_REPAIR_v1
// Source-grep regression guards. These do not exercise the runtime DB; they
// pin the file-level invariants v137 relies on. End-to-end runtime behavior
// is covered by website.readinessFlow.v134 and portalDeleteAndReadinessFallback.v135.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

describe("v137 readiness handoff repair", () => {
  it("(A) migration drops NOT NULL on applications.owner_user_id", () => {
    const sql = fs.readFileSync(
      path.join(repoRoot, "migrations", "2026_05_05_applications_owner_user_id_nullable.sql"),
      "utf-8"
    );
    expect(sql).toContain("BF_SERVER_BLOCK_v137_READINESS_HANDOFF_REPAIR_v1");
    expect(sql).toContain("ALTER TABLE applications ALTER COLUMN owner_user_id DROP NOT NULL");
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("is_nullable = 'NO'");
  });

  it("(B) publicApplication.ts uses id::text=($1)::text for the readiness draft UPDATE", () => {
    const route = fs.readFileSync(
      path.join(repoRoot, "src", "routes", "publicApplication.ts"),
      "utf-8"
    );
    expect(route).toContain("BF_SERVER_BLOCK_v137_READINESS_HANDOFF_REPAIR_v1");
    expect(route).toContain("WHERE id::text = ($1)::text");
    // The original buggy comparison must not regress.
    expect(route).not.toMatch(/WHERE id = \$1::uuid/);
  });
});
