// BF_SERVER_TRANSACTIONAL_BYPASS_UNSUB_v761
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { sendTransactional, sendOne } from "../services/sendgridService.js";

describe("a marketing unsubscribe does not block transactional email", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID; });
  it("transactional sends bypass unsubscribe lists; marketing still honours them", async () => {
    process.env.SENDGRID_API_KEY = "k"; process.env.SENDGRID_FROM = "noreply@boreal.financial"; process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID = "123";
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return { status: 202, text: async () => "" }; }));
    await sendTransactional({ to: "brandon@vossevents.com", subject: "Sign", html: "<p>x</p>" });
    await sendOne({ to: "brandon@vossevents.com", subject: "Offer", html: "<p>x</p>" });
    expect(bodies[0].mail_settings).toEqual({ bypass_unsubscribe_management: { enable: true } });
    expect(bodies[0].asm).toBeUndefined();
    expect(bodies[1].mail_settings).toBeUndefined();
    expect(bodies[1].asm).toEqual({ group_id: 123 });
  });
  it("the weekly staff reports go out as transactional", () => {
    for (const f of ["src/services/weeklySummaryEmail.ts", "src/services/adsWeeklyEmail.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).toContain("sendTransactional({ to, subject, html })");
      expect(s, f).not.toContain("sendOne(");
    }
  });
});
