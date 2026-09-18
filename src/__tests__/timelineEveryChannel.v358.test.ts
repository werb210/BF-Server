// BF_SERVER_TIMELINE_EVERY_CHANNEL_v358
import { describe, it, expect } from "vitest";
import fs from "fs";

const tl = fs.readFileSync("src/routes/crm/timeline.ts", "utf8");
const graph = fs.readFileSync("src/services/email/graphSendService.ts", "utf8");
const bridge = fs.readFileSync("src/routes/serviceBridge.ts", "utf8");

describe("contact timeline covers every channel", () => {
  it("gives logged calls their own kind in both queries", () => {
    expect(tl.match(/SELECT 'call_logged' AS kind/g)?.length).toBe(2);
  });
  it("labels messages by channel instead of calling everything SMS", () => {
    expect(tl).toContain("WHEN channel = 'messenger' THEN 'Talk to a human'");
    expect(tl).toContain("'Email reply in'");
    expect(tl).toContain("ELSE 'message' END) AS kind");
    expect(tl).toContain("WHERE contact_id = $1 AND (silo = $2 OR silo IS NULL)");
  });
  it("marketing email and engagement no longer use the kind the portal discards", () => {
    expect(tl).toContain("ELSE 'email_activity' END) AS kind");
    expect(tl).toContain("WHEN 'email_notice_sent' THEN 'Email sent'");
    expect(tl).toContain("'sms_marketing_sent','email_cascade_sent','email_notice_sent')");
  });
  it("records Graph sends and bridge SMS on the contact", () => {
    expect(graph).toContain("if (result.ok) await recordGraphSendOnTimeline(input);");
    expect(graph).toContain("'email_notice_sent', $2::jsonb FROM contacts c");
    expect(bridge).toContain("await recordBridgeSmsOnTimeline(to, body);");
    expect(bridge).toContain("'sms_marketing_sent', $2::jsonb FROM contacts c");
  });
});
