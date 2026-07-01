import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// BF_SERVER_SHARED_DOCS_COMPANION_ALL_v1 - guards that mirrorDocToSiblingLegs copies a
// parent's uploaded document into a closing-cost companion leg UNCONDITIONALLY (a
// companion is the same borrower/same deal), rather than gating on the companion's own
// required-doc set, which is empty on a freshly-spawned companion.
const src = readFileSync(
  fileURLToPath(new URL("../routes/documents.ts", import.meta.url)),
  "utf-8",
);

describe("companion document sharing", () => {
  it("selects the companion flag from application metadata", () => {
    expect(src).toContain("closing_cost_companion");
    expect(src).toContain("is_companion");
  });
  it("mirrors into companions before consulting the required-set gate", () => {
    expect(src).toContain("let needs = sib.is_companion === true;");
    const flag = src.indexOf("let needs = sib.is_companion === true;");
    const gate = src.indexOf("await computeOutstandingDocs(sibId)");
    expect(flag).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(flag);
  });
});
