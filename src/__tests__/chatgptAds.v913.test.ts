// BF_SERVER_v913_CHATGPT_ADS
import { describe, expect, it } from "vitest";
import { campaignsWithTotals, chatgptAdsKey, ChatgptAdsError, dateRange, setCampaignState } from "../integrations/chatgptAds.js";

function fakeFetch(routes: Record<string, (url: URL, init: any) => { status?: number; body: unknown }>) {
  const calls: Array<{ url: URL; init: any }> = [];
  const f = (async (u: string, init: any) => {
    const url = new URL(u);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { message: "no route " + key } }), { status: 404 });
    const r = h(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("ChatGPT Ads client", () => {
  it("reads the key from the environment", () => {
    expect(chatgptAdsKey({ OPENAI_ADS_API_KEY: "  k1 " } as any)).toBe("k1");
    expect(chatgptAdsKey({} as any)).toBeNull();
  });

  it("clamps the date range to today and defaults to 30 days", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(dateRange(undefined, undefined, now)).toEqual({ since: "2026-10-11", until: "2026-11-09" });
    expect(dateRange("2026-11-01", "2027-01-01", now)).toEqual({ since: "2026-11-01", until: "2026-11-09" });
    expect(dateRange("bad", "2026-11-05", now)).toEqual({ since: "2026-10-11", until: "2026-11-05" });
  });

  it("joins campaigns with their totals, drops archived, sorts by spend", async () => {
    const { f, calls } = fakeFetch({
      "GET /v1/campaigns": () => ({ body: { object: "list", has_more: false, data: [
        { id: "c1", name: "Equipment", status: "active", bidding_type: "clicks", budget: { lifetime_spend_limit_micros: 500_000_000 } },
        { id: "c2", name: "Working capital", status: "paused", budget: { lifetime_spend_limit_micros: 100_000_000 } },
        { id: "c3", name: "Old", status: "archived" },
      ] } }),
      "GET /v1/ad_account/insights": () => ({ body: { object: "list", has_more: false, data: [
        { campaign_id: "c1", impressions: 1000, clicks: 40, spend: 82.5, ctr: 0.04, cpc: 2.06, conversions: 3 },
        { campaign_id: "c2", impressions: 10, clicks: 1, spend: 1.2 },
      ] } }),
    });
    const rows = await campaignsWithTotals("key", { since: "2026-11-01", until: "2026-11-09" }, f);
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(rows[0]).toMatchObject({ lifetime_budget: 500, clicks: 40, spend: 82.5, conversions: 3, bidding_type: "clicks" });
    expect(rows[1]).toMatchObject({ status: "paused", conversions: 0, ctr: null });
    const ins = calls.find((c) => c.url.pathname.endsWith("/insights"))!;
    expect(ins.url.searchParams.get("aggregation_level")).toBe("campaign");
    expect(ins.url.searchParams.get("time_granularity")).toBe("none");
    expect(JSON.parse(ins.url.searchParams.get("time_ranges[]")!)).toEqual({ type: "date_range", since: "2026-11-01", until: "2026-11-09" });
    expect(ins.init.headers.Authorization).toBe("Bearer key");
  });

  it("pauses and activates, and rejects odd ids", async () => {
    const { f } = fakeFetch({ "POST /v1/campaigns/c1/pause": () => ({ body: { id: "c1", status: "paused" } }) });
    await expect(setCampaignState("key", "c1", "pause", f)).resolves.toEqual({ id: "c1", status: "paused" });
    await expect(setCampaignState("key", "../x", "pause", f)).rejects.toBeInstanceOf(ChatgptAdsError);
  });

  it("maps a bad key to bad_key", async () => {
    const { f } = fakeFetch({ "GET /v1/campaigns": () => ({ status: 401, body: { error: { message: "invalid key" } } }) });
    await expect(campaignsWithTotals("bad", { since: "2026-11-01", until: "2026-11-09" }, f)).rejects.toMatchObject({ code: "bad_key" });
  });
});
