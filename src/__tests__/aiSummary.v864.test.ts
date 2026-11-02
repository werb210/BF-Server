// BF_SERVER_v864_AI_SUMMARY_FIX - the contact AI summary either summarizes or says clearly why not, and logs the real
// error on the server. (The SQL itself runs against real Postgres in aiSummary.v864.integration.test.ts.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSummary, SummaryError } from "../modules/crmUnify/aiSummary.js";

const CONTACT = "11111111-1111-1111-1111-111111111111";

function db(opts: { factsError?: Error; saveError?: Error } = {}) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM contacts c LEFT JOIN companies co/.test(sql)) {
        if (opts.factsError) throw opts.factsError;
        return { rows: [{ email: "aandwfarm2021@gmail.com", secondary_email: null, website: null, domain: null, company_email: null, applications: 1, notes: 0, messages: 0, calls: 0, emails: 0, visits: 0 }] };
      }
      if (/INSERT INTO crm_ai_summaries/.test(sql)) {
        if (opts.saveError) throw opts.saveError;
        return { rows: [] };
      }
      throw new Error("unexpected SQL " + sql.slice(0, 60));
    }),
  } as any;
}

describe("AI summary errors (v864)", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { err = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => err.mockRestore());

  it("compares visitor_sessions.contact_id (text) with the contact id as text", async () => {
    const d = db();
    await generateSummary(d, { brief: async () => "Applied for a term loan.", background: async () => null }, "BF", "contact", CONTACT, null);
    const factsSql = String(d.query.mock.calls[0][0]);
    expect(factsSql).toContain("v.contact_id = c.id::text");
    expect(factsSql).not.toMatch(/v\.contact_id = c\.id\)/);
  });

  it("summarizes a contact with an application but no communications (free email: website skipped)", async () => {
    const out = await generateSummary(db(), { brief: async () => "Walter applied for a $2.2M term loan.", background: async () => null }, "BF", "contact", CONTACT, null);
    expect(out!.summary).toBe("Walter applied for a $2.2M term loan.");
    expect(out!.sources.find((s) => s.type === "website")!.status).toBe("skipped");
    expect(out!.sources.find((s) => s.type === "applications")!.detail).toBe("1");
  });

  it("an OpenAI failure becomes a clear message and the real error is logged", async () => {
    const boom = Object.assign(new Error("429 You exceeded your current quota"), { status: 429 });
    const p = generateSummary(db(), { brief: async () => { throw boom; }, background: async () => null }, "BF", "contact", CONTACT, null);
    await expect(p).rejects.toBeInstanceOf(SummaryError);
    await expect(p).rejects.toThrow(/Try again in a minute/);
    expect(err).toHaveBeenCalledWith("[crm-ai-summary] the AI request failed", expect.objectContaining({ id: CONTACT, message: "429 You exceeded your current quota", status: 429 }));
  });

  it("a database read failure is logged and named", async () => {
    const p = generateSummary(db({ factsError: new Error('operator does not exist: text = uuid') }), { brief: async () => "x", background: async () => null }, "BF", "contact", CONTACT, null);
    await expect(p).rejects.toMatchObject({ code: "summary_read_failed" });
    expect(err).toHaveBeenCalledWith("[crm-ai-summary] reading the record failed", expect.objectContaining({ message: "operator does not exist: text = uuid" }));
  });

  it("still returns the summary when it cannot be cached", async () => {
    const out = await generateSummary(db({ saveError: new Error("disk full") }), { brief: async () => "Fine.", background: async () => null }, "BF", "contact", CONTACT, null);
    expect(out!.summary).toBe("Fine.");
    expect(err).toHaveBeenCalledWith("[crm-ai-summary] saving the summary failed", expect.objectContaining({ message: "disk full" }));
  });
});
