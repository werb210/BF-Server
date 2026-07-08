// BF_SERVER_EMAIL_HARDENING_v1 - source assertions: the fixes stay in place.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("email hardening v1", () => {
  it("app.ts captures raw body for webhook signature verification", () => {
    const s = read("src/app.ts");
    expect(s).toContain("rawBody");
    expect(s).toMatch(/express\.json\(\{\s*limit: "10mb", verify:/);
  });

  it("sendgrid webhook verifies over rawBody and only suppresses permanent signals", () => {
    const s = read("src/routes/sendgridWebhook.ts");
    expect(s).toContain("(req as any).rawBody");
    expect(s).not.toMatch(/SUPPRESS = new Set\(\[[^\]]*"dropped"/);
    expect(s).toContain("isSuppressEvent");
    expect(s).toMatch(/event === "bounce" && String\(ev\?\.type \?\? "bounce"\) === "bounce"/);
  });

  it("sendOne has a hard timeout so a hung socket cannot freeze the send-queue worker", () => {
    const s = read("src/services/sendgridService.ts");
    expect(s).toContain("AbortController");
    expect(s).toContain("signal: ctl.signal");
  });

  it("raw email panel supports include/exclude tags and landing hosting is best-effort", () => {
    const s = read("src/routes/marketing.ts");
    const sendRoute = s.slice(s.indexOf('router.post("/email/send"'), s.indexOf('router.get("/send-jobs"'));
    expect(sendRoute).toContain("tagArr(b.tags)");
    expect(sendRoute).toContain("tagArr(b.excludeTags)");
    expect(sendRoute).toContain("countEmailRecipients(pool, silo, tag, includeTags, excludeTags)");
    expect(sendRoute).toMatch(/try \{\s*\n\s*const \{ url: __viewUrl \}/);
  });
});
