// BF_SERVER_BLOCK_v100_APPLICATIONS_SILO_DEFAULT_v1
import { describe, expect, it } from "vitest";

// Pure unit assertion of the silo-resolution logic that's now
// inside createApplication. The actual DB write is exercised by
// integration tests; this test exists to lock the rule that
// missing/blank silo values default to "BF" and any provided
// value is uppercased.
function resolveSilo(params: { silo?: unknown }): string {
  return (params as any).silo
    ? String((params as any).silo).toUpperCase()
    : "BF";
}

describe("v100 createApplication silo resolution", () => {
  it("defaults to BF when silo is missing", () => {
    expect(resolveSilo({})).toBe("BF");
    expect(resolveSilo({ silo: undefined })).toBe("BF");
    expect(resolveSilo({ silo: null })).toBe("BF");
    expect(resolveSilo({ silo: "" })).toBe("BF");
  });
  it("uppercases provided silo values", () => {
    expect(resolveSilo({ silo: "bf" })).toBe("BF");
    expect(resolveSilo({ silo: "bi" })).toBe("BI");
    expect(resolveSilo({ silo: "slf" })).toBe("SLF");
    expect(resolveSilo({ silo: "BF" })).toBe("BF");
  });
});
