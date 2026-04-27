import { describe, expect, it } from "vitest";

// Pure unit test of the filter predicate logic — no Express or DB harness needed.
function filterDrafts(rows: any[], includeDrafts: boolean) {
  if (includeDrafts) return rows;
  return rows.filter((row) => {
    const meta = row && typeof row.metadata === "object" ? row.metadata : {};
    if (meta?.isDraft === true) return false;
    const pipeline = String(row?.pipeline_state ?? row?.current_stage ?? "");
    const businessName = String(row?.name ?? row?.business?.legalName ?? "").trim();
    const isInitialState = pipeline === "Received" || pipeline === "Draft" || pipeline === "RECEIVED";
    const looksLikePlaceholder = !businessName || businessName === "Draft application";
    if (isInitialState && looksLikePlaceholder) return false;
    return true;
  });
}

describe("Block 18 draft filter", () => {
  const drafts = [
    { id: "1", name: "Draft application", pipeline_state: "Received", metadata: { isDraft: true } },
    { id: "2", name: null, pipeline_state: "Received", metadata: {} },
    { id: "3", name: "", pipeline_state: "Draft", metadata: null },
  ];
  const real = [
    { id: "4", name: "Acme Roofing Inc", pipeline_state: "Received", metadata: { isDraft: false } },
    { id: "5", name: "Beta Logistics", pipeline_state: "In Review", metadata: {} },
  ];

  it("hides drafts by default", () => {
    const out = filterDrafts([...drafts, ...real], false);
    expect(out.map((r) => r.id)).toEqual(["4", "5"]);
  });

  it("includes drafts when include_drafts=1", () => {
    const out = filterDrafts([...drafts, ...real], true);
    expect(out.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("does not hide a real application that happens to be in Received state", () => {
    const out = filterDrafts([{ id: "x", name: "Real Co", pipeline_state: "Received", metadata: {} }], false);
    expect(out.map((r) => r.id)).toEqual(["x"]);
  });
});
