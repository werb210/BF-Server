import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNTANT_ALWAYS_AVAILABLE, isAccountantVisible } from "../routes/accountant.js";

const route = readFileSync(fileURLToPath(new URL("../routes/accountant.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_ACCOUNTANT_SURFACE_TRUTH_v3", () => {
  it("shows only what the application requires", () => {
    // The bug: an application needing one document listed four, because the
    // always-available set was appended to every response.
    expect(route).toContain("uploads: requested.map(");
    expect(route).not.toContain("[...requested, ...extras]");
  });

  it("no longer computes an extras list at all", () => {
    expect(route).not.toContain("const extras = ACCOUNTANT_ALWAYS_AVAILABLE");
  });

  it("derives received from documents that exist", () => {
    // The bug: outstanding was "not in stillNeeded", so a category nobody asked
    // for reported itself as received before anything was uploaded.
    expect(route).toContain("FROM documents d");
    expect(route).toContain("receivedCategories");
    expect(route).toContain("outstanding: !receivedCategories.has(");
  });

  it("does not count a rejected document as received", () => {
    expect(route).toContain("COALESCE(d.status, '') <> 'rejected'");
  });

  it("no longer treats absence from stillNeeded as received", () => {
    expect(route).not.toContain("stillNeeded.has(normaliseCategory(category))");
  });

  it("keeps the always-available categories acceptable on upload", () => {
    // They are no longer offered unprompted, but if a staff member adds one as
    // a requirement the upload endpoint must still take it.
    for (const category of ACCOUNTANT_ALWAYS_AVAILABLE) {
      expect(isAccountantVisible(category)).toBe(true);
    }
  });

  it("still refuses applicant-only documents", () => {
    expect(isAccountantVisible("Personal net worth statement")).toBe(false);
    expect(isAccountantVisible("2 pieces of Government Issued ID")).toBe(false);
  });
});
