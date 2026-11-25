// BF_SERVER_SILO_DASHBOARDS_v1 - BI and Keystone Dashboard sections survive a save, and Keystone has its own layout.
import { describe, expect, it } from "vitest";
import { cleanCards } from "../routes/reportsSection.js";
import { REPORTS } from "../services/reports/catalog.js";

describe("silo dashboards", () => {
  it("keeps BI and KS dashboard cards when a layout is cleaned", () => {
    const out = cleanCards("Admin", [{ id: "a", report: "bi_dash_stages", size: "half" }, { id: "b", report: "ks_dash_kpis", size: "full" }, { id: "c", report: "not_a_card", size: "full" }]);
    expect(out.map((c) => c.report)).toEqual(["bi_dash_stages", "ks_dash_kpis"]);
  });
  it("hides the marketing flow cards from Staff", () => {
    expect(cleanCards("Staff", [{ id: "a", report: "bi_dash_flows" }, { id: "b", report: "ks_dash_flows" }])).toEqual([]);
  });
  it("lists Keystone dashboard sections under KS only", () => {
    const ks = REPORTS.filter((r) => r.silo === "KS");
    expect(ks.length).toBeGreaterThan(0);
    expect(ks.every((r) => r.key.startsWith("ks_dash_") && r.source === "dashboard")).toBe(true);
  });
});
