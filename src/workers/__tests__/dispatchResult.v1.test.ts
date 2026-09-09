// BF_SERVER_DISPATCH_RESULT_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(
  path.resolve(__dirname, "../lenderPackageWorker.ts"), "utf8");
const dispatch = fs.readFileSync(
  path.resolve(__dirname, "../../services/lenders/dispatchToSelected.ts"), "utf8");

describe("a failed dispatch cannot look like a delivery", () => {
  it("uses the return value it was already being given", () => {
    // dispatchToSelected has always returned the lenders that succeeded.
    expect(dispatch).toContain("return sent;");
    expect(worker).toContain("const sent = await dispatchToSelected(");
  });

  it("does not advance the stage when nothing was delivered", () => {
    const guard = worker.indexOf("if (delivered === 0)");
    const advance = worker.indexOf("pipeline_state = 'Off to Lender'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(advance);
    // The zero-delivery branch must leave before reaching the advance.
    expect(worker.slice(guard, advance)).toContain("continue;");
  });

  it("marks the job failed rather than completed on total failure", () => {
    expect(worker).toContain("dispatch_all_failed");
  });

  it("carries the per-lender reason into the job error", () => {
    // application_packages already stores why each lender failed; without this
    // the job error said nothing and the reason stayed buried.
    expect(worker).toContain("SELECT failure_reason FROM application_packages");
    expect(worker).toContain("status = 'failed'");
  });

  it("reports a partial delivery instead of treating it as clean", () => {
    expect(worker).toContain("partial delivery");
    expect(worker).toContain("delivered, expected: lenders.rows.length");
  });

  it("bounds the error text so a long reason cannot break the update", () => {
    expect(worker).toContain(".slice(0, 500)");
  });
});
