// BF_SERVER_MAYA_ADS_INSIGHTS_v712
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applyAdRules, picturedInsights, isToddOnlyAction, ADS_RULES } from "../services/adsRules.js";
const sg = (kind: string, title = "t", rationale = "r") => ({ id: kind, kind, title, rationale, severity: "info" as const, action: { type: kind } as any });
describe("Boreal's ad rules", () => {
  it("holds back pause advice while Google records no conversions", () => { const r = applyAdRules([sg("pause_campaign"), sg("pause_keyword"), sg("add_negative")], { conversions: 0 }); expect(r.suggestions.map((s) => s.kind)).toEqual(["add_negative"]); expect(r.caveats[0]).toContain("no conversions"); expect(applyAdRules([sg("pause_campaign")], { conversions: 3 }).suggestions).toHaveLength(1); });
  it("marks Todd-only advice", () => { const r = applyAdRules([sg("set_budget", "Raise budget")], { conversions: 5 }); expect(r.suggestions[0].toddOnly).toBe(true); expect(r.suggestions[0].title).toContain("(Todd decides)"); expect(isToddOnlyAction({ type: "set_budget" })).toBe(true); expect(isToddOnlyAction({ type: "pause_keyword" })).toBe(false); });
  it("drops Quebec and demographic targeting", () => { expect(applyAdRules([sg("x", "Target Quebec"), sg("y", "Narrow by gender"), sg("z", "Add negative")], { conversions: 5 }).suggestions.map((s) => s.kind)).toEqual(["z"]); });
  it("states five rules", () => { expect(ADS_RULES).toHaveLength(5); expect(ADS_RULES.join(" ")).toMatch(/Quebec/); });
});
describe("full-picture findings", () => { it("turns reports into findings", () => { const out = picturedInsights({ story: { totals: { clicks: 300, started: 12, submitted: 0 } }, dropoff: { steps: [{ step: 1, stopped: 9, from_ad: 7 }, { step: 3, stopped: 2 }] }, health: { checks: [{ label: "Conversion upload", status: "fail", detail: "rejected" }, { label: "GA4", status: "ok", detail: "" }] } }); expect(out.map((i) => i.title)).toEqual(["Ad clicks are not becoming submitted applications", "Most unfinished applications stop at Step 1", "Google connection problem: Conversion upload"]); }); });
describe("wiring", () => { const mkt = readFileSync("src/routes/marketing.ts", "utf8"); it("uses rules", () => { expect(mkt).toContain("applyAdRules(built.suggestions, { conversions })"); expect(mkt).toContain('error: "todd_only"'); }); it("email uses rules and findings", () => { const mail = readFileSync("src/services/adsWeeklyEmail.ts", "utf8"); expect(mail).toContain("applyAdRules("); expect(mail).toContain("fullPictureInsights(7)"); }); });
