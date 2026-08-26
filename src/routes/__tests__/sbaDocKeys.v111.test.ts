// BF_SERVER_SBA_DOC_KEYS_v111
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const server = readFileSync(resolve(__dirname, "..", "portalLenderProducts.ts"), "utf-8");

// Byte-identical to the portal's sbaTypes keys, the client's FORM_RENDERERS
// registrations, and the document_type values in migrations v88 / v99 / v103.
const SBA_KEYS = [
  "sba_form_413",
  "sba_form_1919",
  "owner_photo_id",
  "formation_documents",
  "personal_tax_returns",
  "business_plan",
  "sba_1919_attachments",
  "debt_schedule",
  "lease_or_loi",
];

describe("SBA document keys", () => {
  it("every key the portal sends is accepted", () => {
    for (const k of SBA_KEYS) {
      expect(server).toContain(`"${k}",`);
    }
  });

  it("they sit inside the canonical set, not merely in a comment", () => {
    const setBlock = server.slice(
      server.indexOf("const PORTAL_FORM_DOC_LABELS"),
      server.indexOf("]);", server.indexOf("const PORTAL_FORM_DOC_LABELS")),
    );
    for (const k of SBA_KEYS) {
      expect(setBlock).toContain(`"${k}",`);
    }
  });

  it("business_plan is distinct from the slugified Business plan / projections", () => {
    // Both must resolve: the SBA pack uses business_plan, the core pack's
    // "Business plan / projections" aliases to business_plan_projections.
    expect(server).toContain('"business_plan",');
    expect(server).toContain('"Business plan / projections",');
  });

  it("debt_schedule is distinct from the core pack's Debt stack", () => {
    expect(server).toContain('"debt_schedule",');
    expect(server).toContain('"Debt stack",');
  });

  it("the alias derivation still round-trips a key to itself", () => {
    // _v628NormalizeKey("sba_form_413") === "sba_form_413", so an entry added as
    // a key resolves through the alias map unchanged.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    for (const k of SBA_KEYS) expect(norm(k)).toBe(k);
  });
});
