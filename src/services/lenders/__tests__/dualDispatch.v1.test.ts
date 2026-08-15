// BF_SERVER_DUAL_DISPATCH_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/services/lenders/dispatchToSelected.ts", "utf8");

describe("email and sheet in one dispatch", () => {
  it("appends the sheet row after a successful email send", () => {
    // The loop was a single if/else on submission_method, so a lender set to
    // "email" could never reach the sheet branch. Merchant Growth needs both.
    expect(src).toContain("if (ok && l.google_sheet_id) {");
    expect(src).toContain("const sheet = await appendLenderSheetRow(ctx, l, deps);");
  });

  it("does not attempt the sheet when the email failed", () => {
    const guard = src.slice(src.indexOf("if (ok && l.google_sheet_id)"));
    expect(guard.startsWith("if (ok &&")).toBe(true);
  });

  it("does not attempt the sheet for a lender with no sheet configured", () => {
    expect(src).toContain("l.google_sheet_id) {");
  });

  it("fails the dispatch when the email sent but the sheet did not", () => {
    // A silent sheet failure must not read as a clean submission.
    expect(src).toContain("email_sent_but_sheet_failed");
  });

  it("records both destinations when both succeed", () => {
    expect(src).toContain('[deliveredTo, sheet.deliveredTo].filter(Boolean).join(" + ")');
  });
});

describe("the sheet append is shared, not duplicated", () => {
  it("exists once as a function used by both routes", () => {
    expect((src.match(/async function appendLenderSheetRow/g) ?? []).length).toBe(1);
    expect((src.match(/appendLenderSheetRow\(ctx, l, deps\)/g) ?? []).length).toBe(2);
  });

  it("keeps the idempotency claim so a retry cannot append twice", () => {
    expect(src).toContain("INSERT INTO lender_sheet_dispatches");
    expect(src).toContain("ON CONFLICT (application_id, lender_id) DO NOTHING");
  });

  it("still builds the real column-ordered row, not a blank one", () => {
    expect(src).toContain("merchantGrowthSheet.js");
    expect(src).toContain("buildSheetRow(rowData)");
  });

  it("still refuses a fraud-marked application before anything is sent", () => {
    expect(src.indexOf("assertApplicationNotFraud")).toBeLessThan(src.indexOf("for (const l of lenders)"));
  });
});
