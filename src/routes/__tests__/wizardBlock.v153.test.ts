// BF_SERVER_WIZARD_BLOCK_v153
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pub = readFileSync(resolve(__dirname, "..", "public.ts"), "utf-8");
const marketing = readFileSync(resolve(__dirname, "..", "marketing.ts"), "utf-8");
const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_30_v153_wizard_block_events.sql"), "utf-8");

describe("the block is recorded when it happens", () => {
  it("has a public endpoint, because the applicant is not identified yet", () => {
    expect(pub).toContain('router.post(\n  "/wizard-block"');
  });

  it("requires a reason and nothing else", () => {
    expect(pub).toContain('if (!reason) return res.status(400).json(fail(res, "INVALID_INPUT"));');
  });

  it("keeps the row even with no application and no contact", () => {
    // A cold visitor cannot be identified, and the count still answers the
    // question that prompted this.
    expect(mig).toContain("application_id  TEXT,");
    expect(mig).toContain("contact_id      TEXT,");
    expect(mig).not.toContain("application_id TEXT NOT NULL");
  });
});

describe("it does not inflate the count", () => {
  it("one row per session per reason", () => {
    expect(mig).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_wbe_session_reason");
    expect(pub).toContain("ON CONFLICT DO NOTHING");
  });
});

describe("it fills in what the wizard never sent", () => {
  it("writes monthlyRevenue onto the application", () => {
    expect(pub).toContain("'{kyc,monthlyRevenue}'");
  });

  it("preserves the rest of metadata rather than replacing it", () => {
    expect(pub).toContain("COALESCE(metadata,'{}'::jsonb)");
    expect(pub).toContain("COALESCE(metadata->'kyc','{}'::jsonb)");
  });

  it("notes it on the CRM timeline when there is a contact", () => {
    expect(pub).toContain("INSERT INTO crm_notes (contact_id, body, silo)");
    // No created_by column on that table, and contact_id is a uuid.
    expect(pub).toContain("($1)::uuid");
    expect(pub).toContain("Stopped at the application:");
  });
});

describe("the abandoned list can tell a hard stop from a wander-off", () => {
  it("returns the reason", () => {
    expect(marketing).toContain("AS block_reason");
    expect(marketing).toContain("blockReason: r.block_reason ?? null");
  });

  it("takes the most recent one", () => {
    expect(marketing).toContain("ORDER BY w.created_at DESC LIMIT 1");
  });
});

describe("migration safety", () => {
  it("is idempotent", () => {
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS wizard_block_events");
    expect((mig.match(/IF NOT EXISTS/g) || []).length).toBe(4);
  });

  it("does not use pg_trgm", () => {
    expect(mig).not.toContain("pg_trgm");
  });

  it("creates the table it writes to", () => {
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS wizard_block_events");
    expect(pub).toContain("INSERT INTO wizard_block_events");
  });
});
