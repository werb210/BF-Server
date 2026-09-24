// BF_SERVER_BLOCK_v482_MARK_SENT_TO_LENDER
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routes = readFileSync(fileURLToPath(new URL("../modules/applications/applications.routes.ts", import.meta.url)), "utf-8");
const migration = readFileSync(fileURLToPath(new URL("../../migrations/2026_09_24_v482_manual_lender_send.sql", import.meta.url)), "utf-8");

describe("v482 mark as sent to lender", () => {
  it("migration is idempotent", () => {
    const adds = migration.match(/ADD COLUMN/g) ?? [];
    const safe = migration.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds.length).toBe(3);
    expect(safe.length).toBe(3);
  });
  it("route is write-gated and records a sent package flagged as manual", () => {
    expect(routes).toContain("router.post('/:id/lenders/:lenderId/mark-sent', requireCapability([CAPABILITIES.CRM_WRITE])");
    expect(routes).toContain("VALUES ($1, $2::uuid, 'sent', NOW(), TRUE, $3, $4, NOW())");
    expect(routes).toContain("ON CONFLICT (application_id, lender_id) DO UPDATE");
  });
  it("moves to Off to Lender but never backwards from later stages", () => {
    expect(routes).toMatch(/NOT IN \('Off to Lender','Additional Steps Required','Offer','Accepted','Rejected','Declined','Funded','Closed'\)/);
  });
  it("sent-lenders tells the portal which sends were recorded by hand", () => {
    expect(routes).toContain("BOOL_OR(COALESCE(p.sent_manually, FALSE)) AS sent_manually");
    expect(routes).toContain("manual: Boolean(x.sent_manually)");
  });
});
