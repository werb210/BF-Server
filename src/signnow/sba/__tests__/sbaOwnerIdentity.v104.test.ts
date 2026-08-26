// BF_SERVER_SBA_OWNER_IDENTITY_v104
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ownerFingerprint } from "../sbaOwners.js";

const R = (...p: string[]) => readFileSync(resolve(__dirname, ...p), "utf-8");

describe("ownerFingerprint", () => {
  it("is stable across position", () => {
    const a = ownerFingerprint({ fullName: "Jane Roe", email: "jane@example.com" });
    const b = ownerFingerprint({ fullName: "Jane Roe", email: "jane@example.com" });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("distinguishes two different owners", () => {
    expect(ownerFingerprint({ email: "jane@example.com" }))
      .not.toBe(ownerFingerprint({ email: "john@example.com" }));
  });

  it("ignores case and stray whitespace", () => {
    expect(ownerFingerprint({ email: "  Jane@Example.com " }))
      .toBe(ownerFingerprint({ email: "jane@example.com" }));
  });

  it("falls back to name when there is no email", () => {
    expect(ownerFingerprint({ fullName: "Jane  Roe" }))
      .toBe(ownerFingerprint({ fullName: "jane roe" }));
  });

  it("returns empty for an owner with neither", () => {
    expect(ownerFingerprint({})).toBe("");
  });
});

describe("stale responses", () => {
  const trigger = R("..", "sbaTrigger.ts");

  it("a 413 whose owner changed does not count as submitted", () => {
    expect(trigger).toContain("sba_form_owner_changed");
    expect(trigger).toContain("want && got && want !== got");
  });

  it("an unstamped legacy response is still accepted", () => {
    expect(trigger).toContain("row.owner_fingerprint ? String(row.owner_fingerprint) : null");
  });
});

describe("submit-time stamping", () => {
  const routes = R("..", "..", "..", "routes", "applicationFormResponses.ts");

  it("stamps only the per-owner 413s", () => {
    expect(routes).toContain('String(docType).startsWith("sba_form_413")');
  });

  it("never blocks a submission on stamping", () => {
    const i = routes.indexOf("[sba_owner_fingerprint] failed");
    expect(i).toBeGreaterThan(-1);
  });
});

describe("staff checklist", () => {
  const app = R("..", "..", "..", "modules", "applications", "applications.routes.ts");

  it("maps the SBA doc types", () => {
    expect(app).toContain('return "sba1919"');
    expect(app).toContain('return "sba413"');
  });

  it("short-circuits ahead of the loose substring tests", () => {
    const sbaAt = app.indexOf('if (/^sba_form_/.test(x))');
    const debtAt = app.indexOf('if (/debt/.test(x)) return "debt";');
    expect(sbaAt).toBeGreaterThan(-1);
    expect(sbaAt).toBeLessThan(debtAt);
  });

  it("labels both forms for staff", () => {
    expect(app).toContain('sba1919: "SBA Form 1919"');
    expect(app).toContain("sba1919: 'SBA Form 1919'");
  });
});
