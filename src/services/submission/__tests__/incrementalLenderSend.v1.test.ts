// BF_SERVER_INCREMENTAL_LENDER_SEND_v1
// Source-level guards. The dispatch path needs a live pg pool to exercise end to
// end, so these assert the properties that regressed in production instead.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const orchestrator = read("src/services/submission/orchestrator.ts");
const dispatch = read("src/services/lenders/dispatchToSelected.ts");

describe("incremental lender send", () => {
  it("claims the dispatch lock with a stale window, not IS NULL only", () => {
    expect(orchestrator).toContain("submission_packages_started_at < NOW() - ($2 || ' minutes')::interval");
  });

  it("excludes lenders that already received the package from the dispatch set", () => {
    expect(orchestrator).toContain("AND p.status = 'sent')");
  });

  it("releases the dispatch lock unconditionally so later sends are possible", () => {
    expect(orchestrator).not.toContain("SELECT 1 FROM application_packages WHERE application_id::text = $1\n          )`");
    expect(orchestrator).toContain("the lock is released on EVERY exit path");
  });

  it("reports already_sent only when selections exist but none are unsent", () => {
    expect(orchestrator).toContain('anySel.rows.length > 0 ? "already_sent" : "no_selected_lenders"');
  });

  it("records the real outcome of every attempt, in both directions", () => {
    // BF_SERVER_PER_LENDER_PACKAGE_v1 - this used to assert
    //   WHERE application_packages.status <> 'sent'
    // which was added so a FAILED row could later record a success. It had the
    // mirror-image flaw: a row already marked 'sent' could never record a later
    // FAILURE, so a failed re-send was silently discarded and the portal kept
    // showing the old "Sent" date. Confirmed in production on Desklinx. The
    // guard is gone; every attempt now writes its real status.
    expect(dispatch).toContain("ON CONFLICT (application_id, lender_id) DO UPDATE");
    const sql = dispatch
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toContain("WHERE application_packages.status <> 'sent'");
    expect(dispatch).toContain("status = EXCLUDED.status");
    expect(dispatch).toContain("failure_reason = EXCLUDED.failure_reason");
  });

  it("keeps the first delivery timestamp when a later attempt fails", () => {
    // sent_at must survive: knowing WHEN a lender first received the package is
    // not invalidated by a failed resend.
    expect(dispatch).toContain("sent_at = COALESCE(application_packages.sent_at, EXCLUDED.sent_at)");
  });
});
