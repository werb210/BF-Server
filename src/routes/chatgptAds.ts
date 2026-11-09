// BF_SERVER_v913_CHATGPT_ADS - /api/chatgpt-ads (Admin and Marketing): Marketing > Ads > ChatGPT.
//   GET  /campaigns?since=YYYY-MM-DD&until=YYYY-MM-DD   campaigns with impressions, clicks, spend, CTR, CPC, conversions
//   POST /campaigns/:id/pause | /campaigns/:id/activate  (audited)
// Without a key it answers { configured: false } so the tab can say where to add it.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { campaignsWithTotals, chatgptAdsKey, ChatgptAdsError, dateRange, setCampaignState } from "../integrations/chatgptAds.js";

const router = Router();
router.use(requireAuth);

const allowed = (req: any) => ["admin", "marketing"].includes(String(req.user?.role ?? "").toLowerCase());

function fail(res: any, err: unknown) {
  if (err instanceof ChatgptAdsError) {
    console.warn("[chatgpt-ads] request failed", { status: err.status, code: err.code, message: err.message });
    return res.status(err.status >= 500 || err.status === 401 ? 502 : err.status).json({ ok: false, error: err.code, message: err.message });
  }
  throw err;
}

router.get("/campaigns", safeHandler(async (req: any, res: any) => {
  if (!allowed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const key = chatgptAdsKey();
  const range = dateRange(req.query?.since, req.query?.until);
  if (!key) return res.json({ ok: true, configured: false, range, campaigns: [] });
  try {
    const campaigns = await campaignsWithTotals(key, range);
    const total = campaigns.reduce((a, c) => ({ impressions: a.impressions + c.impressions, clicks: a.clicks + c.clicks, spend: a.spend + c.spend, conversions: a.conversions + c.conversions }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });
    res.json({ ok: true, configured: true, range, campaigns, total });
  } catch (err) { return fail(res, err); }
}));

for (const state of ["pause", "activate"] as const) {
  router.post(`/campaigns/:id/${state}`, safeHandler(async (req: any, res: any) => {
    if (!allowed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const key = chatgptAdsKey();
    if (!key) return res.status(409).json({ ok: false, error: "not_configured", message: "Add the ChatGPT Ads key in Settings > Your services." });
    try {
      const r = await setCampaignState(key, String(req.params.id), state);
      try {
        const { recordAuditEvent } = await import("../modules/audit/audit.service.js");
        await recordAuditEvent({ actorUserId: String(req.user?.id ?? req.user?.userId ?? "") || null, targetUserId: null, targetType: "chatgpt_ads_campaign", targetId: r.id, action: `chatgpt_ads_${state}`, success: true, metadata: { status: r.status } } as any);
      } catch (err) { console.warn("[chatgpt-ads] audit failed", String((err as Error)?.message ?? err)); }
      res.json({ ok: true, ...r });
    } catch (err) { return fail(res, err); }
  }));
}

export default router;
