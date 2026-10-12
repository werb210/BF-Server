// BF_SERVER_SEQUENCE_CONSENT_GATE_v31
import { beforeEach, describe, it, expect, vi } from "vitest";
import { enrollSequence, hasSmsConsent, tickSequences } from "../sequenceEngine.js";
import { CONSENT_SQL } from "../smsConsent.js";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  sendMarketingSms: vi.fn(async () => ({ ok: true, sid: "SM1" })),
  sendOne: vi.fn(async () => ({ ok: true, status: 202 })),
}));
vi.mock("../marketingSms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../marketingSms.js")>()),
  sendMarketingSms: h.sendMarketingSms,
  lookupLineType: vi.fn(async () => "mobile"),
}));
vi.mock("../sendgridService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sendgridService.js")>()),
  sendOne: h.sendOne,
}));
vi.mock("../fraud/fraudGuard.js", () => ({ contactHasFraudApplication: vi.fn(async () => false) }));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("hasSmsConsent", () => {
  it("accepts express consent regardless of age", () => {
    expect(hasSmsConsent({ sms_consent: true, consent_at: daysAgo(5000) })).toBe(true);
  });

  it("rejects a contact who merely never opted out", () => {
    expect(hasSmsConsent({ sms_consent: false, consent_basis: null, consent_at: null })).toBe(false);
  });

  it("accepts implied_transaction inside 2 years and rejects outside", () => {
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: daysAgo(700) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: daysAgo(800) })).toBe(false);
  });

  it("accepts implied_inquiry inside 6 months and rejects outside", () => {
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: daysAgo(100) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: daysAgo(200) })).toBe(false);
  });

  it("rejects an unknown basis and an unparseable date", () => {
    expect(hasSmsConsent({ consent_basis: "vibes", consent_at: daysAgo(1) })).toBe(false);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: "not-a-date" })).toBe(false);
  });
});

// One claimed enrollment on an "auto" step: SMS when the contact is textable, email otherwise.
async function runAutoStep(contact: Record<string, unknown>) {
  let claimed = false;
  const query = vi.fn(
    answerBySql([
      [/UPDATE marketing_sequence_enrollments SET status='running'/, () => {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: "en-1", sequence_id: "seq-1", contact_id: "c-1", current_step: 0, enrolled_at: new Date(), last_step_at: null, stop_on_reply: false, quiet_start: null, quiet_end: null }] };
      }],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1/, { rows: [{ channel: "auto", wait_minutes: 0, condition: null, subject: "Hi", body: "Hello {{first_name}}", html: null, link_url: null }] }],
      [/FROM contacts WHERE id=\$1/, { rows: [{ id: "c-1", silo: "BF", name: "Ann Lee", email: "ann@acme.test", phone: "+15875550100", line_type: "mobile", sms_opt_out: false, marketing_opt_out: false, ...contact }] }],
      [/INSERT INTO sequence_sends/, { rows: [{ id: "send-1" }] }],
    ]),
  );
  await tickSequences({ query } as any);
  return query;
}

describe("sequenceEngine wiring", () => {
  beforeEach(() => {
    h.sendMarketingSms.mockClear();
    h.sendOne.mockClear();
  });

  it("applies the consent test to the textable branch", async () => {
    await runAutoStep({ sms_consent: true, consent_basis: "express", consent_at: daysAgo(5000) });
    expect(h.sendMarketingSms).toHaveBeenCalledTimes(1);
    expect(h.sendOne).not.toHaveBeenCalled();

    h.sendMarketingSms.mockClear();
    // Never opted out is not consent: the auto step falls back to email.
    await runAutoStep({ sms_consent: false, consent_basis: null, consent_at: null });
    expect(h.sendMarketingSms).not.toHaveBeenCalled();
    expect(h.sendOne).toHaveBeenCalledTimes(1);

    h.sendOne.mockClear();
    await runAutoStep({ sms_consent: false, consent_basis: "implied_inquiry", consent_at: daysAgo(200) });
    expect(h.sendMarketingSms).not.toHaveBeenCalled();
    expect(h.sendOne).toHaveBeenCalledTimes(1);
  });

  it("selects the consent columns it needs", async () => {
    const query = await runAutoStep({ sms_consent: true });
    const sql = String(callsMatching(query, /FROM contacts WHERE id=\$1/)[0]![0]);
    expect(sql).toContain("COALESCE(sms_consent,false) AS sms_consent");
    expect(sql).toContain("consent_basis");
    expect(sql).toContain("consent_at");
  });

  it("fails closed when no audience tags are selected", async () => {
    const query = vi.fn(
      answerBySql([
        [/FROM marketing_sequences WHERE id=\$1/, { rows: [{ silo: "BF", audience_tag: null, audience_include_tags: [], audience_exclude_tags: [], quiet_start: null, quiet_end: null }], rowCount: 1 }],
        [/INSERT INTO marketing_sequence_enrollments/, { rows: [], rowCount: 0 }],
      ]),
    );
    expect(await enrollSequence({ query } as any, "seq-1")).toBe(0);
    const insert = callsMatching(query, /INSERT INTO marketing_sequence_enrollments/);
    expect(insert).toHaveLength(1);
    expect((insert[0]![1] as unknown[])[3]).toEqual([]);
    const sql = String(insert[0]![0]);
    expect(sql).toContain("AND cardinality($4::text[]) > 0");
    expect(sql).not.toContain("cardinality($4::text[]) = 0 OR");
  });
});

describe("parity with the blast runner", () => {
  it("smsConsent.ts still defines the windows this mirrors", () => {
    expect(CONSENT_SQL).toContain("COALESCE(c.sms_consent, false) = true");
    expect(CONSENT_SQL).toMatch(/consent_basis = 'implied_transaction' AND c\.consent_at > now\(\) - interval '2 years'/);
    expect(CONSENT_SQL).toMatch(/consent_basis = 'implied_inquiry'\s+AND c\.consent_at > now\(\) - interval '6 months'/);
  });
});
