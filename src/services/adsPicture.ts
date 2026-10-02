// BF_SERVER_MAYA_ADS_INSIGHTS_v712 - full-picture findings for Maya's ad advice.
import { logError } from "../observability/logger.js";
import { picturedInsights, type Insight } from "./adsRules.js";

export async function fullPictureInsights(days: number): Promise<Insight[]> {
  const { storyReport, dropoffReport } = await import("../routes/marketing/adsStory.js");
  let story: any = null, dropoff: any = null, health: any = null;
  try { story = await storyReport(days, "campaign"); } catch (err: any) { logError("ads_picture_story_failed", { message: err?.message }); }
  try { dropoff = await dropoffReport(days); } catch (err: any) { logError("ads_picture_dropoff_failed", { message: err?.message }); }
  try { health = await (await import("./googleHealth.js")).getGoogleHealth(false); } catch (err: any) { logError("ads_picture_health_failed", { message: err?.message }); }
  return picturedInsights({ story, dropoff, health });
}
