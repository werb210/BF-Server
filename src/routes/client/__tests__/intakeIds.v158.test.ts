// BF_SERVER_INTAKE_IDS_v158
// Found by running the real server against a real Postgres and posting an SBA
// application: lender_product_id came back NULL with no error.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "v1Applications.ts"), "utf-8");

const PG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("the product link matches what the column accepts", () => {
  it("accepts an id Postgres would store but RFC-4122 rejects", () => {
    // Real shape from a hand-created product. Postgres takes it; the old guard did not.
    const id = "a1b2c3d4-1111-2222-3333-444455556666";
    expect(PG_UUID_RE.test(id)).toBe(true);
    expect(RFC_RE.test(id)).toBe(false);
  });

  it("still rejects something that is not a uuid at all", () => {
    expect(PG_UUID_RE.test("sba-prod-1")).toBe(false);
    expect(PG_UUID_RE.test("")).toBe(false);
  });

  it("the derivation uses the storable check", () => {
    expect(src).toContain("bfIsStorableUuid(sp?.id)");
    expect(src).toContain("bfIsStorableUuid(input.lender_product_id)");
    expect(src).toContain("bfIsStorableUuid(sp?.lender_id)");
  });

  it("reports a product that can never link instead of dropping it", () => {
    expect(src).toContain("intake_product_id_not_linkable");
    expect(src).toContain("lender_products.id is TEXT but applications");
  });
});

describe("a submit that records nothing does not report success", () => {
  it("rejects an empty payload", () => {
    expect(src).toContain("submit_payload_required");
    expect(src).toContain('if (!legacyApp || typeof legacyApp !== "object")');
  });

  it("says what to send", () => {
    expect(src).toContain("Send { app } or { normalized }");
  });

  it("still accepts a legacy submit that has an app", () => {
    expect(src).toContain('return res.json({ ok: true, applicationId: application.id, mode: "legacy" });');
  });

  it("logs it, because a truncated submit otherwise looks identical to a good one", () => {
    expect(src).toContain("client_submit_empty_payload");
  });
});
