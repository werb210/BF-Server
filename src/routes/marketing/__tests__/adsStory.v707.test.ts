// BF_SERVER_ADS_STORY_v707
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildStoryRows, storyBy, windowDays } from "../adsStory.js";
describe("ads story rows",()=>{
 it("joins spend to outcomes and computes metrics",()=>{ const rows=buildStoryRows([{k:"BF Search",people:4,started:3,submitted:2,qualified:1,funded:1,funded_amount:"100000"}],[{k:"BF Search",spend:"1000",clicks:50},{k:"Idle",spend:"10",clicks:1}],.03); const bf=rows.find(r=>r.key==="BF Search")!; expect(bf.commission).toBe(3000); expect(bf.roas).toBe(3); expect(bf.costPerSubmit).toBe(500); expect(rows.find(r=>r.key==="Idle")?.roas).toBe(0); });
 it("keeps missing spend null",()=>expect(buildStoryRows([{k:"Ad 1",people:1}],[],.03)[0].spend).toBeNull());
 it("parses inputs safely",()=>{expect(storyBy("keyword")).toBe("keyword");expect(storyBy("no")).toBe("campaign");expect(windowDays("30")).toBe(30);expect(windowDays("9999")).toBe(90);});
});
describe("wiring",()=>{ const marketing=readFileSync("src/routes/marketing.ts","utf8"); it("mounts routes and guards pauses",()=>{expect(marketing).toContain('import adsStoryRoutes from "./marketing/adsStory.js"');expect(marketing).toContain("router.use(adsStoryRoutes)");expect(marketing).toContain("BF_SERVER_ADS_PAUSE_GUARD_v707");expect(marketing).toContain('sg.kind !== "pause_campaign"');}); it("reconciles negatives safely",()=>{expect(marketing).toContain("BF_SERVER_NEGATIVES_RECONCILE_v707");expect(marketing).toContain("if (names.length > 0)");expect(marketing).toContain('logError("negatives_reconcile_failed"');}); it("exposes stuck jobs",()=>expect(readFileSync("src/routes/admin.ts","utf8")).toContain("stuck: stuck.rows")); });
