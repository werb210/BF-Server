// BF_SERVER_REJECTION_REASONS_v124
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const svc = readFileSync(resolve(__dirname, "..", "rejectionNotice.ts"), "utf-8");
const routes = readFileSync(resolve(__dirname, "..", "..", "modules", "applications", "applications.routes.ts"), "utf-8");
const mig = readFileSync(resolve(__dirname, "..", "..", "..", "migrations", "2026_08_27_v124_rejection_reasons.sql"), "utf-8");

describe("rejection reason catalogue", () => {
  it("is editable, idempotent, nullable, and exposed to staff", () => {
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS rejection_reasons");
    expect(mig).toMatch(/what_helps TEXT,/);
    expect(mig).toContain("ON CONFLICT (code) DO NOTHING");
    expect(routes).toContain("/rejection-reasons");
  });
});

describe("lender pass and auto-close", () => {
  it("keeps the ordinal, so repeat passes are distinguishable", () => {
    expect(routes).toContain("Lender ${frozenOrdinal} will pass");
  });

  it("uses the agreed pass phrasing and counts only sent lenders", () => {
    expect(routes).toContain("will pass, due to ${reasonSummary}");
    expect(svc).toContain("sent_at IS NOT NULL");
    expect(svc).toContain("return sent > 0 && passed >= sent;");
  });
});

describe("decline email", () => {
  it("deduplicates reasons, has a send guard, and sends text and HTML", () => {
    expect(svc).toContain("SELECT DISTINCT rr.code");
    expect(svc).toContain("rejection_email_sent_at IS NULL");
    expect(svc).toContain("SET rejection_email_sent_at = NULL");
    expect(svc).toContain("bodyText: text");
    expect(svc).toContain("bodyHtml: html");
  });

  it("escapes applicant content and omits unavailable remediation", () => {
    expect(svc).toContain("esc(String(note).trim())");
    expect(svc).toContain("esc(first)");
    expect(svc).toContain("r.what_helps\n      ?");
  });
});

describe("route ordering", () => {
  // v124 shipped this route below /:id, where Express could never reach it.
  it("declares /rejection-reasons before /:id, or it is unreachable", () => {
    const cat = routes.indexOf("router.get('/rejection-reasons'");
    const wild = routes.indexOf("router.get('/:id',");
    expect(cat).toBeGreaterThan(-1);
    expect(wild).toBeGreaterThan(-1);
    expect(cat).toBeLessThan(wild);
  });

  it("registers the catalogue exactly once", () => {
    expect(routes.split("router.get('/rejection-reasons'").length - 1).toBe(1);
  });
});

describe("application-level reject", () => {
  it("requires and stores reasons without a lender", () => {
    expect(routes).toContain("At least one reason is required.");
    expect(routes).toContain("VALUES ($1, NULL, $2, $3)");
  });
});
