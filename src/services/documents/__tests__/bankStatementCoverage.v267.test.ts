// BF_SERVER_BANK_COVERAGE_v267
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { bankCoverageForApplication, computeCoverage, parsePeriodText, periodFromDisplayName } from "../bankStatementCoverage.js";

const REF = "2026-09";
const stmt = (over: Partial<{ displayName: string | null; filename: string | null; txFirst: string | null; txLast: string | null }>) =>
  ({ documentId: Math.random().toString(36).slice(2), displayName: null, filename: null, txFirst: null, txLast: null, ...over });

describe("reading the period staff typed", () => {
  it("understands months, years, ranges and partial months", () => {
    expect(parsePeriodText("July", REF)).toEqual({ months: ["2026-07"], partial: false });
    expect(parsePeriodText("December", REF)).toEqual({ months: ["2025-12"], partial: false });
    expect(parsePeriodText("Jul 2025", REF)).toEqual({ months: ["2025-07"], partial: false });
    expect(parsePeriodText("2026-03", REF)).toEqual({ months: ["2026-03"], partial: false });
    expect(parsePeriodText("June-August", REF)).toEqual({ months: ["2026-06", "2026-07", "2026-08"], partial: false });
    expect(parsePeriodText("September 1-11", REF)).toEqual({ months: ["2026-09"], partial: true });
    expect(parsePeriodText("Q2", REF)).toBeNull();
  });
  it("takes the period from an accepted document name", () => {
    expect(periodFromDisplayName("Voss Events Inc - Bank Statement - July.pdf")).toBe("July");
    expect(periodFromDisplayName("statement.pdf")).toBeNull();
  });
});

describe("coverage for Voss Events", () => {
  const nine = [
    stmt({ filename: "20260131-statements-5274-.pdf" }), stmt({ filename: "20260228-statements-5274-.pdf" }),
    stmt({ filename: "20260331-statements-5274-.pdf" }), stmt({ filename: "20260430-statements-5274-.pdf" }),
    stmt({ filename: "20260531-statements-5274-.pdf" }), stmt({ filename: "20260630-statements-5274-.pdf" }),
    stmt({ filename: "20260731-statements-5274-.pdf" }), stmt({ filename: "20260831-statements-5274-.pdf" }),
    stmt({ filename: "Sept 1-11.pdf", displayName: "Voss Events Inc - Bank Statement - September 1-11.pdf" }),
  ];
  it("Mar–Aug required, all present, September counted as partial", () => {
    const c = computeCoverage(nine, REF, 6);
    expect(c.expectedMonths).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(c.missingMonths).toEqual([]);
    expect(c.currentMonthPartial).toBe(true);
    expect(c.summary).toBe("Jan 2026 – Aug 2026 · Sep 2026 (partial) · 6 of 6 months · no gaps");
  });
  it("names the gap when a month is missing and counts undated statements", () => {
    const c = computeCoverage([...nine.filter((s) => s.filename !== "20260531-statements-5274-.pdf"), stmt({ filename: "scan.pdf" })], REF, 6);
    expect(c.missingMonths).toEqual(["2026-05"]);
    expect(c.summary).toContain("missing May 2026");
    expect(c.summary).toContain("1 statement not dated");
  });
  it("prefers dates from extracted transactions over names", () => {
    const c = computeCoverage([stmt({ displayName: "X - Bank Statement - July.pdf", txFirst: "2026-06-01", txLast: "2026-06-30" })], REF, 6);
    expect(c.coveredMonths).toEqual(["2026-06"]);
  });
});

describe("from the database", () => {
  it("only counts non-rejected bank statements and reads the months from the requirement label", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: "a", category: "3 months business banking statements", filename: "20260831-s.pdf", display_name: null, tx_first: null, tx_last: null },
      { id: "b", category: "3 years accountant prepared financials", filename: "2024.pdf", display_name: null, tx_first: null, tx_last: null },
    ] });
    const c = await bankCoverageForApplication("app1", new Date(Date.UTC(2026, 8, 15)), query as any);
    expect(c?.requiredMonths).toBe(3);
    expect(c?.statements).toBe(1);
    expect(String(query.mock.calls[0][0])).toContain("<> 'rejected'");
  });
  it("returns nothing when the application has no bank statements", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await bankCoverageForApplication("app1", new Date(), query as any)).toBeNull();
  });
  it("is included in the portal application payload", () => {
    expect(fs.readFileSync("src/routes/portal.ts", "utf8")).toContain("bankCoverage = await bankCoverageForApplication(record.id)");
  });
});
