// BF_SERVER_CRM_CONTEXT_v653
import { describe, expect, it } from "vitest";
import { contactContextSections, type ContextDeps } from "../services/crm/contactContext.js";

function fakeDeps(overrides: Partial<ContextDeps> = {}): ContextDeps {
  return {
    async query(sql: string) {
      if (sql.includes("FROM contact_ad_attribution")) return { rows: [{ campaign_name: "Search - LOC", ad_group_name: "Line of credit", keyword: "business line of credit", keyword_match_type: "PHRASE", click_date: "2026-09-20" }] };
      if (sql.includes("FROM google_ads_daily")) return { rows: [{ cost: 300, clicks: 60, conversions: 4 }] };
      if (sql.includes("utm_term")) return { rows: [{ utm_term: "loc for gym", utm_campaign: "Search - LOC" }] };
      if (sql.includes("FROM visitor_events")) return { rows: [
        { path: "/", title: "Home", event_type: "page_view", dwell_ms: 12000, occurred_at: "2026-09-20T10:00:00Z" },
        { path: "/", title: "Home", event_type: "page_view", dwell_ms: 1000, occurred_at: "2026-09-20T10:00:05Z" },
        { path: "/line-of-credit", title: "Line of Credit", event_type: "page_view", dwell_ms: 45000, occurred_at: "2026-09-20T10:01:00Z" },
      ] };
      if (sql.includes("FROM chat_messages")) return { rows: [
        { role: "assistant", text: "Happy to help, how much do you need?", created_at: "2026-09-20T10:03:00Z" },
        { role: "user", text: "About 150k for equipment", created_at: "2026-09-20T10:02:00Z" },
      ] };
      if (sql.includes("FROM readiness_sessions")) return { rows: [{ readiness_score: 72, readiness_tier: "strong", requested_amount: 150000, funding_type: "Line of credit", created_at: "2026-09-19" }] };
      if (sql.includes("FROM users")) return { rows: [{ first_name: "Pat", last_name: "Lee", company_name: "Lee Accounting" }] };
      if (sql.includes("FROM referral_conversions")) return { rows: [] };
      if (sql.includes("FROM documents")) return { rows: [{ status: "accepted", n: 4 }, { status: "uploaded", n: 1 }] };
      if (sql.includes("FROM lender_submissions")) return { rows: [{ lender: "Accord", status: "submitted", submitted_at: "2026-09-22" }] };
      if (sql.includes("FROM offers")) return { rows: [{ lender_name: "Accord", amount: 150000, rate_factor: "1.18", term: "12 months", status: "accepted" }] };
      throw new Error("unexpected SQL: " + sql.slice(0, 80));
    },
    actionCenter: async () => ({ outstanding: [{ label: "PGI application" }, { label: "Void cheque", urgent: true }] }),
    pgiStage: async () => "documents_pending",
    biPerson: async () => ({ ok: true, contact: { name: "Sam Gym", lifecycle_stage: "customer" }, applications: [{ public_id: "BI-123", business_name: "Todd's Gym", stage: "quote_ready", coverage_amount: 120000, annual_premium: 2400, updated_at: "2026-09-25" }] }),
    ...overrides,
  };
}

const contact = { id: "c1", email: "sam@toddsgym.ca", phone: "+14035550100", referrer_id: "u9" };
const apps = [{ id: "a1", name: "Todd's Gym LOC", pipeline_state: "Offer", requested_amount: 150000, pending_acceptance_offer_id: "o1", pending_acceptance_at: "2026-09-24", bi_public_id: "BI-123" }];

describe("v653 CRM context", () => {
  it("covers ads, referral, readiness, journey, Maya chat, application depth and insurance", async () => {
    const text = (await contactContextSections(contact, apps, fakeDeps())).join("\n\n");
    expect(text).toContain('keyword "business line of credit" (phrase)');
    expect(text).toContain("$300 spend, 60 clicks, 4 conversions, about $5 per click");
    expect(text).toContain('Searched "loc for gym"');
    expect(text).toContain("Referred by Pat Lee of Lee Accounting");
    expect(text).toContain("score 72 (strong), asking $150,000");
    expect(text).toContain("Line of Credit (45s)");
    expect(text.match(/Home/g)?.length).toBe(1);
    expect(text.indexOf("About 150k")).toBeLessThan(text.indexOf("Happy to help"));
    expect(text).toContain("Client still has to do: PGI application; Void cheque (rejected, re-upload)");
    expect(text).toContain("Documents received: 4 accepted, 1 uploaded");
    expect(text).toContain("Sent to lenders: Accord (submitted 2026-09-22)");
    expect(text).toContain("Offers: Accord $150,000 1.18 12 months (accepted)");
    expect(text).toContain("term sheet accepted 2026-09-24");
    expect(text).toContain("PGI (personal guarantee insurance): documents pending");
    expect(text).toContain("PGI application BI-123 for Todd's Gym: stage quote ready, coverage $120,000, premium $2,400");
  });

  it("leaves out a section whose read fails instead of failing the summary", async () => {
    const deps = fakeDeps({
      async query(sql: string) { if (sql.includes("FROM visitor_events")) throw new Error("boom"); return fakeDeps().query(sql, []); },
      biPerson: async () => { throw new Error("bi down"); },
      actionCenter: async () => { throw new Error("no center"); },
    });
    const text = (await contactContextSections(contact, apps, deps)).join("\n\n");
    expect(text).not.toContain("Website journey");
    expect(text).not.toContain("Boreal Insurance side");
    expect(text).toContain("Client still has to do: nothing");
    expect(text).toContain("How they found us");
  });

  it("returns nothing for a bare contact", async () => {
    const empty = fakeDeps({ async query() { return { rows: [] }; }, biPerson: async () => null });
    expect(await contactContextSections({ id: "c2" }, [], empty)).toEqual([]);
  });
});
