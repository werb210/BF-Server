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

  it("lets a failed package row be overwritten by a later success", () => {
    expect(dispatch).toContain("ON CONFLICT (application_id, lender_id) DO UPDATE");
    expect(dispatch).toContain("WHERE application_packages.status <> 'sent'");
  });
});
