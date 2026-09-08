// BF_SERVER_ABANDONED_NUDGE_v61 - Todd was texting every abandoned applicant
// by hand. This does it on a schedule and books the follow-up call.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/workers/abandonedApplicationWorker.ts", "utf8");
const MIG = fs.readFileSync("migrations/2026_08_22_v61_abandoned_nudge.sql", "utf8");
const INDEX = fs.readFileSync("src/index.ts", "utf8");

describe("timing", () => {
  it("texts 4 hours after last activity", () => {
    expect(SRC).toContain("const SMS_AFTER_HOURS = 4;");
  });

  it("books the call task 2 days after", () => {
    expect(SRC).toContain("const CALL_TASK_AFTER_DAYS = 2;");
  });
});

describe("it cannot text the same person twice", () => {
  it("stamps the application once sent", () => {
    expect(SRC).toContain("abandon_sms_sent_at = now()");
    expect(SRC).toContain("a.abandon_sms_sent_at IS NULL");
  });

  it("stamps only AFTER a successful send, so an outage retries", () => {
    // BF_SERVER_ABANDON_NUDGE_ASSERT_v2
    // The invariant is that the SUCCESS stamp follows the send, so a Twilio
    // outage retries instead of silently skipping the applicant. indexOf found
    // the first occurrence of the stamp string, and v160 added an earlier one
    // that retires a number the deliverability guard rejected -- different
    // purpose, same text. Assert the behaviours, not their byte offsets.
    const send = SRC.indexOf("await sendSMS(");
    expect(send).toBeGreaterThan(-1);

    // A stamp exists after the send: success is recorded.
    expect(SRC.indexOf("abandon_sms_sent_at = now()", send)).toBeGreaterThan(send);

    // Every stamp before the send is inside the undeliverable guard, i.e. it
    // retires a number we will never text, not a send we never made.
    const beforeSend = SRC.slice(0, send);
    const earlyStamps = beforeSend.split("abandon_sms_sent_at = now()").length - 1;
    if (earlyStamps > 0) {
      const guard = beforeSend.lastIndexOf("isUndeliverableNumber(");
      const lastEarlyStamp = beforeSend.lastIndexOf("abandon_sms_sent_at = now()");
      expect(guard).toBeGreaterThan(-1);
      expect(lastEarlyStamp).toBeGreaterThan(guard);
    }

    // The stamp is never inside the catch: a failed send must stay eligible.
    const catchIndex = SRC.indexOf("} catch (err)", send);
    if (catchIndex > -1) {
      const catchBody = SRC.slice(catchIndex);
      const permanentOnly = catchBody.indexOf("isPermanentSmsFailure");
      const stampInCatch = catchBody.indexOf("abandon_sms_sent_at = now()");
      if (stampInCatch > -1) {
        // Only a permanent rejection may stamp from the catch (v119).
        expect(permanentOnly).toBeGreaterThan(-1);
        expect(permanentOnly).toBeLessThan(stampInCatch);
      }
    }
  });

  it("does the same for the call task", () => {
    expect(SRC).toContain("abandon_task_created_at = now()");
    expect(SRC).toContain("a.abandon_task_created_at IS NULL");
  });
});

describe("consent", () => {
  it("respects STOP replies", () => {
    expect(SRC).toContain("COALESCE(c.sms_opt_out, false) = false");
  });

  it("stops contacting after the 6-month CASL implied-consent window", () => {
    expect(SRC).toContain("const CONSENT_WINDOW_MONTHS = 6;");
    expect(SRC).toContain("months')::interval");
  });

  it("never texts a blank number", () => {
    expect(SRC).toContain("btrim(c.phone) <> ''");
  });
});

describe("the task", () => {
  it("goes to the contact owner, never the seeded admin", () => {
    expect(SRC).toContain("SELECT owner_id FROM contacts");
    expect(SRC).toContain("id::text <> '00000000-0000-0000-0000-000000000099'");
  });

  it("is findable as a group", () => {
    // BF_SERVER_ABANDON_TEST_v66 - v64 moved source to 'WORKFLOW' because
    // tasks.source only permits MANUAL|SEQUENCE|WORKFLOW|IMPORT|API. These
    // tasks are identified by their title instead.
    expect(SRC).toContain("'WORKFLOW', NULL)");
    expect(SRC).toContain("Call: started an application, did not finish");
    expect(SRC).not.toContain("'ABANDONED_APPLICATION'");
  });
});

describe("wiring", () => {
  it("is idempotent and indexed", () => {
    expect(MIG).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_sent_at");
    expect(MIG).toContain("CREATE INDEX IF NOT EXISTS idx_applications_abandon_nudge");
  });

  it("starts with the other workers", () => {
    expect(INDEX).toContain("startAbandonedApplicationWorker");
  });
});
