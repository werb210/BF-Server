// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1
// Source-grep regression guards. These pin the file-level invariants v138
// relies on; runtime behavior is covered by per-route integration tests.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf-8");

describe("v138 E2E fix batch", () => {
  it("AUDIT-19: documents.ts INSERT writes document_type from category", () => {
    const src = read("src/routes/documents.ts");
    expect(src).toContain("BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1");
    expect(src).toContain("document_type, created_at, updated_at)");
    expect(src).toContain("'uploaded','pending',$10,$5,now(),now()");
  });

  it("AUDIT-19: backfill migration shipped", () => {
    const sql = read("migrations/2026_05_05_documents_document_type_backfill.sql");
    expect(sql).toContain("BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1");
    expect(sql).toContain("UPDATE documents");
    expect(sql).toContain("SET document_type = category");
  });

  it("AUDIT-10: dashboard.ts /actions and /pipeline are gated", () => {
    const src = read("src/routes/dashboard.ts");
    expect(src).toContain('router.get("/actions", requireAuth');
    expect(src).toContain('router.get("/pipeline", requireAuth');
    expect(src).not.toMatch(/router\.get\("\/actions",\s*safeHandler/);
    expect(src).not.toMatch(/router\.get\("\/pipeline",\s*safeHandler/);
  });

  it("AUDIT-11: offers.ts (3 routes) are gated", () => {
    const src = read("src/routes/offers.ts");
    expect(src).toContain('import { requireAuth, requireAuthorization } from "../middleware/auth.js"');
    expect(src).toContain('import { ROLES } from "../auth/roles.js"');
    const matches = src.match(/requireAuthorization\(\{ roles: \[ROLES\.ADMIN, ROLES\.STAFF\] \}\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("AUDIT-12: submissionOrchestration.ts (2 routes) are gated", () => {
    const src = read("src/routes/submissionOrchestration.ts");
    expect(src).toContain("BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1");
    expect(src).toContain('router.post("/applications/:id/lenders/send", requireAuth, requireAuthorization');
    expect(src).toContain('router.post("/applications/:id/submit-trigger-check", requireAuth, requireAuthorization');
  });

  it("AUDIT-13 + AUDIT-17: offerAcceptance.ts /confirm-acceptance gated, /accept wires in", () => {
    const src = read("src/routes/offerAcceptance.ts");
    expect(src).toContain("BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1");
    expect(src).toContain('router.post("/:id/confirm-acceptance", requireAuth, requireAuthorization');
    expect(src).toContain("UPDATE applications");
    expect(src).toContain("pending_acceptance_offer_id = $1::uuid");
    expect(src).toContain("pending_acceptance_at = NOW()");
  });
});
