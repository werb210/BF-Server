// BF_SERVER_LENDER_PACKAGE_BACKOFF_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(
  path.resolve(__dirname, "../lenderPackageWorker.ts"), "utf8");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../../migrations/2026_09_08_v161_lender_package_backoff.sql"), "utf8");

describe("an unsigned application cannot starve the lender queue", () => {
  it("no gate requeues without a next_attempt_at", () => {
    // This is the whole bug: the claim query admits any pending row whose
    // COALESCE(next_attempt_at, created_at) <= NOW(), so a bare status reset
    // is re-claimed 15 seconds later, forever.
    expect(worker).not.toMatch(/status = 'pending', updated_at = now\(\) WHERE id = \$1/);
  });

  it("every signing gate goes through the backoff helper", () => {
    expect(worker.match(/await requeueUnsigned\(/g)?.length).toBe(3);
  });

  it("sets a future next_attempt_at when requeueing", () => {
    expect(worker).toContain("next_attempt_at = now() + ($2 || ' milliseconds')::interval");
  });

  it("gives up eventually rather than spinning forever", () => {
    // Default is ~14 days at a 5 minute interval.
    expect(worker).toContain("MAX_UNSIGNED_ATTEMPTS");
    expect(worker).toContain("status = 'failed'");
    expect(worker).toContain("giving up — never signed");
  });

  it("counts attempts so give-up is bounded, not time-guessed", () => {
    expect(migration).toContain("attempts INTEGER NOT NULL DEFAULT 0");
    expect(worker).toContain("COALESCE(attempts, 0) + 1");
  });

  it("still refuses to dispatch anything unsigned", () => {
    // The gates must remain; only their retry behaviour changes.
    for (const gate of [
      "signnow_app_signed_at IS NOT NULL",
      "pnwSigningSatisfiedForDispatch",
      "sbaSigningSatisfiedForDispatch",
    ]) {
      expect(worker).toContain(gate);
    }
  });

  it("keeps the migration idempotent", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS attempts");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS job_queue_ready_idx");
  });
});
