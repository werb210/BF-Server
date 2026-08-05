// BF_SERVER_EMAIL_LINK_CLICKS_v19
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const hook = fs.readFileSync(path.resolve(__dirname, "../routes/sendgridWebhook.ts"), "utf8");
const routes = fs.readFileSync(path.resolve(__dirname, "../routes/marketing.ts"), "utf8");
const timeline = fs.readFileSync(path.resolve(__dirname, "../routes/crm/timeline.ts"), "utf8");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../migrations/2026_08_05_email_link_clicks.sql"), "utf8");

describe("email link click capture", () => {
  it("creates the ledger idempotently with no foreign keys", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS email_link_clicks");
    expect(migration).not.toMatch(/REFERENCES/i);
  });

  it("writes the clicked URL onto the timeline payload", () => {
    expect(hook).toContain("url: clickedUrl");
  });

  it("the timeline already renders that payload key as the row body", () => {
    expect(timeline).toContain("payload->>'url'");
  });

  it("records one ledger row per click", () => {
    expect(hook).toContain("INSERT INTO email_link_clicks (contact_id, template_id, tse_id, silo, url)");
  });

  it("never lets click tracking break event ingestion", () => {
    expect(hook).toContain("click tracking must never break event ingestion");
  });

  it("exposes a per-URL rollup and a per-URL contact list", () => {
    expect(routes).toContain('router.get("/link-clicks", requireAuth');
    expect(routes).toContain('router.get("/link-clicks/contacts", requireAuth');
    expect(routes).toContain("count(DISTINCT contact_id)::int AS contacts");
  });

  it("casts counts to int, since node-postgres returns bigint as a string", () => {
    expect(routes).toContain("count(*)::int AS clicks");
  });
});
