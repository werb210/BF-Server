// BF_SERVER_OFFERS_PENDING_AT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const sql = readFileSync(path.join(process.cwd(), "migrations/2026_07_11_offers_pending_at.sql"), "utf8");
describe("offers pending_at migration", () => {
  it("adds pending_at idempotently", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ");
  });
  it("widens the status check to include pending_acceptance", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS offers_status_check");
    expect(sql).toContain("'pending_acceptance'");
  });
});
