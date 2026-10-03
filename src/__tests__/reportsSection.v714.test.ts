// BF_SERVER_REPORTS_SECTION_v714
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canSee, catalogFor, REPORTS } from "../services/reports/catalog.js";
import { cleanCards } from "../routes/reportsSection.js";

describe("who sees which reports", () => {
  it("Admin sees everything", () => { expect(catalogFor("Admin")).toHaveLength(REPORTS.length); });
  it("Marketing sees everything except money", () => {
    expect(canSee("Marketing", "money")).toBe(false); expect(canSee("Marketing", "marketing")).toBe(true);
    expect(canSee("Marketing", "operations")).toBe(true);
    expect(catalogFor("Marketing").some((r) => r.key === "commission_by_month")).toBe(false);
  });
  it("Staff and Ops see operations only - no money, no marketing", () => {
    for (const role of ["Staff", "Ops", "something-else", undefined]) {
      expect(canSee(role, "money")).toBe(false); expect(canSee(role, "marketing")).toBe(false); expect(canSee(role, "operations")).toBe(true);
    }
    expect(catalogFor("Staff").map((r) => r.group).every((g) => g === "operations")).toBe(true);
  });
});
describe("saved layouts", () => {
  it("a saved card the person may not see is dropped, unknown reports too", () => {
    const cards = cleanCards("Staff", [{ id: "1", report: "stuck_deals", size: "half", days: 30 }, { id: "2", report: "commission_by_month" }, { id: "3", report: "ads_story" }, { id: "4", report: "nope" }]);
    expect(cards).toEqual([{ id: "1", report: "stuck_deals", size: "half", days: 30 }]);
  });
  it("caps a view at 40 cards and a window at 365 days", () => {
    const cards = cleanCards("Admin", Array.from({ length: 50 }, (_, i) => ({ id: String(i), report: "stuck_deals", days: 9999 })));
    expect(cards).toHaveLength(40); expect(cards[0].days).toBe(365);
  });
});
describe("routes", () => {
  const src = readFileSync("src/routes/reportsSection.ts", "utf8");
  it("the data route refuses a report the person may not see", () => { expect(src).toContain('if (!canSee(req.user?.role, def.group)) { res.status(403).json({ error: "not_allowed" }); return; }'); });
  it("only Admins publish team tabs", () => { expect(src).toContain('if (normalizeRole(req.user?.role) !== "Admin") { res.status(403).json({ error: "admin_only" }); return; }'); });
  it("is mounted under /api/reports", () => { expect(readFileSync("src/routes/reports.ts", "utf8")).toContain("router.use(reportsSectionRoutes)"); });
});
