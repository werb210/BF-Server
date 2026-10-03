// BF_SERVER_DASHBOARD_BOARD_v730
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cleanCards } from "../routes/reportsSection.js";
import { REPORTS } from "../services/reports/catalog.js";

describe("movable Dashboard", () => {
  it("keeps the standard sections and the Small size when a Dashboard is saved", () => {
    const out = cleanCards("Staff", [{ id: "dash_kpis", report: "dash_kpis", size: "third" }, { id: "x", report: "dash_pipeline", size: "full" }]);
    expect(out).toEqual([{ id: "dash_kpis", report: "dash_kpis", size: "third" }, { id: "x", report: "dash_pipeline", size: "full" }]);
  });
  it("has all nine standard sections, offered only on the Dashboard", () => {
    expect(REPORTS.filter((r) => r.source === "dashboard").map((r) => r.key)).toHaveLength(9);
    expect(readFileSync("src/routes/reportsSection.ts", "utf8")).toContain('(forDashboard || r.source !== "dashboard")');
  });
});
