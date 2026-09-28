// BF_SERVER_MAYA_INSIGHTS_v655
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { adsPerformance, automationsOverview, commsOverview, referrersOverview, todoStatus, type Q } from "../routes/mayaStaffInsights.js";
import insightsRouter from "../routes/mayaStaffInsights.js";

function fake(answers: Array<[string, any[]]>): Q & { calls: string[] } {
  const calls: string[] = [];
  const q = (async (sql: string) => {
    calls.push(sql);
    const hit = answers.find(([needle]) => sql.includes(needle));
    if (!hit) throw new Error("unexpected SQL: " + sql.slice(0, 90));
    return { rows: hit[1] };
  }) as Q & { calls: string[] };
  q.calls = calls;
  return q;
}

describe("v655 Maya insights", () => {
  it("ads: spend, waste (costly terms with no conversions), converting terms and negatives", async () => {
    const q = fake([
      ["level = 'campaign'", [{ name: "Search - LOC", cost_now: 420.5, conv_now: 3, cost_prev: 380, conv_prev: 1 }]],
      ["level = 'search_term'", [
        { term: "free grants", campaign_name: "Search - LOC", cost: 55.2, clicks: 11, conversions: 0 },
        { term: "business line of credit", campaign_name: "Search - LOC", cost: 90, clicks: 20, conversions: 3 },
        { term: "loan calculator", campaign_name: "Search - LOC", cost: 0, clicks: 0, conversions: 0 },
      ]],
      ["FROM contact_ad_attribution", [{ n: 4 }]],
      ["FROM ads_negatives_log", [{ term: "jobs", match_type: "EXACT" }]],
    ]);
    const out = await adsPerformance(q, 7);
    expect(out.campaigns[0]).toMatchObject({ campaign: "Search - LOC", spend: 420.5, conversions: 3, cost_per_conversion: 140.17 });
    expect(out.wasted_search_terms).toEqual([{ term: "free grants", campaign: "Search - LOC", spend: 55.2, clicks: 11 }]);
    expect(out.converting_search_terms[0].term).toBe("business line of credit");
    expect(out.summary).toBe("Last 7 day(s): 420.50 spend across 1 campaign(s), 4 ad lead(s); 55.20 on 1 search term(s) with no conversions; 1 active negative(s).");
  });

  it("comms: waiting on reply, missed calls, voicemails, call summaries, issues and Team unread for the staff member", async () => {
    const q = fake([
      ["FROM communications_messages", [{ contact_id: "c1", name: "Sam", phone: "+14035550100", body: "Any update?", created_at: "2026-09-28T10:00:00Z", direction: "inbound", read_at: null }]],
      ["call.missed", [{ from_number: "+14035550111", created_at: "2026-09-28T09:00:00Z" }]],
      ["FROM voicemails", [{ from_number: "+1403", transcript: "Call me back" }]],
      ["FROM conferences", [{ name: "Sam", summary: "- Wants 150k" }]],
      ["FROM issues", []],
      ["FROM users u", [{ name: "general", kind: "channel", unread: 3 }]],
    ]);
    const out = await commsOverview(q, "BF", "todd.w@boreal.financial");
    expect(out.waiting_on_reply[0]).toMatchObject({ name: "Sam", last_message: "Any update?", unread: true });
    expect(out.summary).toBe("1 contact(s) waiting on a text reply; 1 missed call(s) and 1 voicemail(s) recently; 0 open issue(s); 3 unread Team message(s).");
    const noUser = fake([["FROM communications_messages", []], ["call.missed", []], ["FROM voicemails", []], ["FROM conferences", []], ["FROM issues", []]]);
    expect((await commsOverview(noUser, "BF", null)).team_unread).toEqual([]);
    expect(noUser.calls.some((s) => s.includes("team_messages"))).toBe(false);
  });

  it("automations and referrers summarize", async () => {
    const a = await automationsOverview(fake([["FROM automation_rules", [{ name: "New lead", enabled: true, active: 2 }, { name: "Old", enabled: false }]], ["FROM marketing_sequences", [{ name: "Nurture", status: "active" }]]]), "BF");
    expect(a.summary).toBe("1 of 2 automation(s) enabled; 1 of 1 sequence(s) active.");
    const r = await referrersOverview(fake([["FROM users u", [{ name: "Pat Lee", referrals: 3, owed: "120.5", paid: "0" }]]]));
    expect(r.summary).toBe("1 referrer(s); 120.50 in commissions credited and not yet paid.");
  });

  it("todo status lists the client's outstanding items and documents shared from other applications", async () => {
    const out = await todoStatus(fake([["FROM document_shares", [{ document_kind: "id", from_application: "Old LOC" }]]]), "a1",
      async () => ({ outstanding: [{ label: "Void cheque", kind: "document", urgent: true }], completed: [{ label: "CRA Authorization" }] }));
    expect(out.outstanding).toEqual([{ label: "Void cheque", kind: "document", rejected: true }]);
    expect(out.shared_from_other_applications[0].from_application).toBe("Old LOC");
    expect(out.summary).toBe("1 item(s) still with the client: Void cheque.");
  });

  it("every insight route refuses calls without the Maya service token", async () => {
    const app = express().use(express.json()).use(insightsRouter);
    for (const path of ["/staff/ads-performance", "/staff/comms-overview", "/staff/automations-overview", "/staff/referrers-overview", "/staff/todo-status", "/staff/contact-picture"]) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(401);
    }
  });
});
