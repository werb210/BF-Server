// BF_SERVER_MARKETING_ON_TIMELINE_v1
import { beforeAll, describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { answerBySql, callsMatching, sqlText } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ timelineQuery: vi.fn(), smsOk: true }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.timelineQuery(sql, params);
  return { ...real, pool: { query: q }, dbQuery: q };
});
vi.mock("../../../services/sendgridService.js", async (orig) => ({ ...(await orig<any>()), sendOne: async () => ({ ok: true, status: 202 }) }));
vi.mock("../../../services/marketingSms.js", async (orig) => ({
  ...(await orig<any>()),
  sendMarketingSms: async () => (h.smsOk ? { ok: true, sid: "SM1" } : { ok: false }),
  lookupLineType: async () => "mobile",
}));

import { runEmailSend, runSmsSend } from "../../../services/marketingSendRunner.js";
import { loadCrmTimeline } from "../timeline.js";

/** Every event type the runner wrote to crm_timeline_events, across an email blast and an SMS campaign. */
const written = new Set<string>();
let timelineSql = "";

function fakePool(rows: unknown[]) {
  const query = vi.fn(answerBySql([
    [/FROM contacts c LEFT JOIN companies co/, { rows }],
    [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
    [/INSERT INTO sms_campaign_sends \(campaign_id, contact_id, silo, phone\)/, { rows: [{ id: "send-1" }] }],
  ]));
  return query;
}
const recordWrites = (query: ReturnType<typeof vi.fn>) => {
  for (const c of callsMatching(query, "INSERT INTO crm_timeline_events")) written.add(String((c[1] as unknown[])[1]));
};

beforeAll(async () => {
  const email = fakePool([{ id: "c-1", email: "a@x.example", name: "Ann", company: null }]);
  await runEmailSend({ query: email } as unknown as Pool, { silo: "BF", tag: "vip", subject: "October rates", html: "<p>Hi</p>" });
  recordWrites(email);

  const textable = { id: "c-2", email: "b@x.example", phone: "+14035230100", name: "Bo", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" };
  const noMobile = { id: "c-3", email: "c@x.example", phone: null, name: "Cy", company: null, sms_ok: false, marketing_opt_out: false, line_type: null };
  const sms = fakePool([textable, noMobile]);
  await runSmsSend({ query: sms } as unknown as Pool, { silo: "BF", tag: "vip", body: "Hi {{first_name}}", linkUrl: null, fbSubject: "Following up", fbHtml: "<p>Hi</p>", createdBy: null } as any);
  recordWrites(sms);

  h.timelineQuery.mockImplementation(answerBySql([]));
  await loadCrmTimeline(true, "c-1", "BF");
  timelineSql = sqlText(h.timelineQuery.mock.calls[0]![0]);
});

/** The event types the contact timeline admits, from the IN (...) list of the query it runs. */
function allowlist(): string[] {
  const m = timelineSql.match(/FROM crm_timeline_events\s+WHERE contact_id = \$1\s+AND event_type IN \(([^)]*)\)/);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : [];
}

describe("marketing sends reach the contact timeline", () => {
  it("the runner still writes the three marketing event types", () => {
    expect([...written].sort()).toEqual(["email_cascade_sent", "email_marketing_sent", "sms_marketing_sent"]);
  });

  it("every event type the runner writes is on the timeline allowlist", () => {
    // The allowlist already had email_open and email_click, so a contact showed
    // "Email opened" with no email above it. Any new event type must be added here too.
    const allowed = allowlist();
    expect(allowed).toEqual(expect.arrayContaining(["email_open", "email_click"]));
    for (const t of written) expect(allowed, t).toContain(t);
  });

  it("renders the subject as the body, not a raw event_type string", () => {
    expect(timelineSql).toContain("WHEN 'email_marketing_sent' THEN 'Marketing email sent'");
    expect(timelineSql).toMatch(/WHEN event_type IN \([^)]*'email_marketing_sent'[^)]*\) THEN\s+NULLIF\(COALESCE\(payload->>'subject',''\), ''\)/);
  });
});
