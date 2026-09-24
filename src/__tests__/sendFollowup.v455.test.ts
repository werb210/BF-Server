// BF_SERVER_BLOCK_v455_SEND_FOLLOWUP
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const read = (p: string) => fs.readFileSync(p, "utf8");

describe("v455 lender send follow-up", () => {
  it("passes the silent-query CI gate", () => {
    expect(() => execFileSync("python3", ["scripts/check-silent-queries.py"], { stdio: "pipe" })).not.toThrow();
  });

  it("the failure-reason lookup logs instead of swallowing", () => {
    expect(read("src/services/submission/orchestrator.ts")).toContain("[orchestrator] failure_reason lookup failed");
  });

  it("a failed delivery leaves a log line", () => {
    expect(read("src/services/lenders/dispatchToSelected.ts")).toContain("[dispatch] lender delivery failed");
  });

  it("a missing submission email names the lender, not its id", () => {
    const src = read("src/modules/lenderSubmissions/adapters/EmailAdapter.ts");
    expect(src).toContain("${input.lender.name || input.lender.id} has no submission_email");
  });

  it("isSbaApplication reads the selected product from lender_submissions", () => {
    const src = read("src/signnow/sba/sbaTrigger.ts");
    expect(src).not.toContain("s.lender_product_id");
    expect(src).toContain("FROM lender_submissions s");
  });

  it("the portal Send logs a failed lender finalize", () => {
    expect(read("src/routes/portal.ts")).toContain("[lender-submissions] finalize selection failed");
  });
});
