// BF_SERVER_ABANDON_SMS_TARGET_v120 (updated by BF_SERVER_ABANDON_NUDGE_OTP_TARGET_v162)
// v120's original intent: never blast the Step-3 business switchboard or a
// fictional number. v120 implemented that by targeting application_contacts
// (role='applicant') - but that row is written only at SUBMIT, so it excluded
// every (never-submitted) abandoned application and the nudge went fully dark.
// v162 keeps the safety intent while fixing the outage: target the OTP-verified
// mobile on a.contact_id, gated by the 'application_started' tag (written only at
// application start, never on a business/company contact), plus all the original
// deliverability guards. These assertions pin that safety contract on the query
// the worker actually runs.
import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null }));
vi.mock("../claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../../services/smsService.js", () => ({ sendSMS: vi.fn(async () => undefined) }));
vi.mock("../../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));

import { sendSMS } from "../../services/smsService.js";
import { startAbandonedApplicationWorker } from "../abandonedApplicationWorker.js";

let smsQuery = "";
let smsParams: unknown[] = [];
let textedTo: unknown[] = [];

beforeAll(async () => {
  const query = vi.fn(answerBySql([
    [/abandon_sms_sent_at IS NULL/, { rows: [{ id: "app-1", contact_id: "c-otp", phone: "+14035230100", silo: "BF" }] }],
  ]));
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  const [call] = callsMatching(query, /abandon_sms_sent_at IS NULL/);
  smsQuery = sqlText(call![0]).replace(/--[^\n]*/g, ""); // the SQL, not its explanatory comments
  smsParams = call![1] as unknown[];
  textedTo = vi.mocked(sendSMS).mock.calls.map((c) => c[0]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("recipient", () => {
  it("targets the OTP-verified contact captured at start", () => {
    expect(smsQuery).toContain("JOIN contacts c ON c.id = a.contact_id");
    expect(smsQuery).toMatch(/SELECT a\.id, a\.contact_id, c\.phone, a\.silo/);
  });

  it("texts the phone that query returns", () => {
    expect(textedTo).toEqual(["+14035230100"]);
  });

  it("only ever nudges a contact proven to be the OTP lead (never the switchboard)", () => {
    expect(smsQuery).toContain("'application_started' = ANY(COALESCE(c.tags, '{}'))");
  });

  it("does not gate on the submit-only applicant role (that is what broke it)", () => {
    // The 4-hour SMS query must not depend on application_contacts, which only
    // exists after submit.
    expect(smsQuery).not.toContain("application_contacts");
    expect(smsQuery).not.toContain("role = 'applicant'");
  });
});

describe("undeliverable numbers never reach Twilio", () => {
  it("blocks the 555-5555 placeholder that caused this", () => {
    expect(smsQuery).toContain("NOT LIKE '%5555555'");
  });

  it("blocks the NANP 555-01xx fictional range", () => {
    expect(smsQuery).toContain("NOT LIKE '%55501__'");
  });

  it("blocks short numbers", () => {
    expect(smsQuery).toMatch(/length\(regexp_replace\(c\.phone, '\[\^0-9\]', '', 'g'\)\) >= 10/);
  });

  it("blocks all-identical digits", () => {
    expect(smsQuery).toContain("!~ '^(.)\\1+$'");
  });
});

describe("regression", () => {
  it("still only targets unsubmitted applications", () => {
    expect(smsQuery).toContain("a.submitted_at IS NULL");
  });

  it("still respects opt-out", () => {
    expect(smsQuery).toContain("COALESCE(c.sms_opt_out, false) = false");
  });

  it("still respects the CASL consent window", () => {
    expect(smsQuery).toContain("a.updated_at > now() - ($2 || ' months')::interval");
    expect(smsParams).toEqual(["4", "6"]);
  });

  it("still batches at 25", () => {
    expect(smsQuery).toMatch(/LIMIT 25\s*$/);
  });
});
