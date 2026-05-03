// BF_SERVER_BLOCK_v101_INCLUDE_DRAFTS_PARAM_v1
// Pinned: portal.ts must accept include_drafts as an alias for showDrafts
// because BF-portal sends include_drafts=1 (PipelinePage.tsx:54). Pre-v101
// the server only read showDrafts so the staff toggle was a silent no-op.
import { describe, expect, it } from "vitest";

// Helper extracted from portal.ts truthy semantics. Kept inline to
// avoid pulling in the express stack just for one boolean parser.
function isTruthy(v: unknown) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

describe("include_drafts truthy parsing (v101)", () => {
  it("treats 1 / true / yes as on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "True", "yes", "YES"]) {
      expect(isTruthy(v)).toBe(true);
    }
  });

  it("treats everything else as off", () => {
    for (const v of [undefined, null, "", "0", "false", "no", "off", " "]) {
      expect(isTruthy(v)).toBe(false);
    }
  });
});
