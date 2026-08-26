// BF_SERVER_SBA_DISPATCH_GATE_HONEST_v102
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");

describe("SBA dispatch gate", () => {
  it("treats the owner list as the authority, not the envelope list", () => {
    expect(src).toContain("resolveSbaOwners(applicationId)");
    expect(src).toContain("sba_dispatch_blocked_missing_envelope");
  });

  it("no longer returns true for an empty envelope list", () => {
    const fn = src.slice(src.indexOf("export async function sbaSigningSatisfiedForDispatch"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toContain("if (envelopes.length === 0) return true;");
  });

  it("refuses dispatch when no owners can be resolved", () => {
    expect(src).toContain("if (owners.length === 0) return false;");
  });

  it("keeps the unconfigured-SignNow escape so non-prod is unaffected", () => {
    expect(src).toContain("if (!isApiKeyConfigured()) return true;");
  });

  it("logs rather than silently thinning the package", () => {
    expect(src).toContain("sba_signed_pdfs_none_available");
  });
});
