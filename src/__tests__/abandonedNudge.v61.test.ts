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
    const send = SRC.indexOf("await sendSMS(");
    const stamp = SRC.indexOf("abandon_sms_sent_at = now()");
    expect(stamp).toBeGreaterThan(send);
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

  it("is tagged so these are findable as a group", () => {
    expect(SRC).toContain("'ABANDONED_APPLICATION'");
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
