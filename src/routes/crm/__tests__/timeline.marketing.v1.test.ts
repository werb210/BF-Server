// BF_SERVER_MARKETING_ON_TIMELINE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const timeline = readFileSync(path.join(process.cwd(), "src/routes/crm/timeline.ts"), "utf8");
const runner = readFileSync(path.join(process.cwd(), "src/services/marketingSendRunner.ts"), "utf8");

describe("marketing sends reach the contact timeline", () => {
  it("the runner still writes the three marketing event types", () => {
    expect(runner).toContain("email_marketing_sent");
    expect(runner).toContain("sms_marketing_sent");
    expect(runner).toContain("email_cascade_sent");
  });

  it("every event type the runner writes is on the timeline allowlist", () => {
    // The allowlist already had email_open and email_click, so a contact showed
    // "Email opened" with no email above it. Any new event type must be added here too.
    for (const t of ["email_marketing_sent", "sms_marketing_sent", "email_cascade_sent"]) {
      expect(timeline).toContain(`'${t}'`);
    }
  });

  it("renders the subject as the body, not a raw event_type string", () => {
    expect(timeline).toContain("'Marketing email sent'");
    expect(timeline).toContain("payload->>'subject'");
  });
});
