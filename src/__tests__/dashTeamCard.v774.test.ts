// BF_SERVER_DASH_TEAM_CARD_v774
import { describe, it, expect } from "vitest";
import { cleanCards } from "../routes/reportsSection.js";
import { catalogFor } from "../services/reports/catalog.js";

describe("the New team messages Dashboard card survives a save", () => {
  it("is kept by cleanCards for every staff role", () => {
    for (const role of ["Admin", "Staff", "Ops", "Marketing"]) {
      expect(cleanCards(role, [{ id: "dash_team", report: "dash_team", size: "third" }])).toEqual([{ id: "dash_team", report: "dash_team", size: "third" }]);
    }
  });
  it("is offered on the Dashboard", () => {
    expect(catalogFor("Staff").some((r) => r.key === "dash_team" && r.source === "dashboard")).toBe(true);
  });
});
