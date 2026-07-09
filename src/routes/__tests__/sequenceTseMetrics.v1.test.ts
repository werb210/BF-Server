// BF_SERVER_SEQUENCE_TSE_METRICS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/routes/marketing.ts"), "utf8");
describe("sequence email metrics from template_send_events (v1)", () => {
  it("emails_sent/opens/clicks come from template_send_events via step templates", () => {
    expect(s).toContain("BF_SERVER_SEQUENCE_TSE_METRICS_v1");
    expect(s).not.toContain("FROM sequence_sends ss WHERE ss.sequence_id=s.id AND ss.channel='email' AND ss.opened_at IS NOT NULL");
    expect(s).toContain("count(tse.opened_at)::int FROM template_send_events");
  });
});
