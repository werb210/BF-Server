// BF_SERVER_SBA_NO_CREDIT_SUMMARY_v754
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async (id: string) => id === "sba-app") }));
import { isSbaForReadiness } from "../services/submission/orchestrator.js";

describe("SBA files never wait for a credit summary", () => {
  it("knows an SBA file from a non-SBA one", async () => {
    expect(await isSbaForReadiness("sba-app")).toBe(true);
    expect(await isSbaForReadiness("other-app")).toBe(false);
  });
  it("the waiver covers SBA as well as deals under $500,000, for both send paths", () => {
    const s = readFileSync("src/services/submission/orchestrator.ts", "utf8");
    expect(s).toContain("const creditSummaryWaived = (await isSbaForReadiness(ctx.applicationId)) || (Number.isFinite(reqAmtNum) && reqAmtNum < 500000);");
    expect(s).toContain("creditSummarySubmitted: Boolean(appRow?.credit_summary_completed_at) || creditSummaryWaived");
  });
});
