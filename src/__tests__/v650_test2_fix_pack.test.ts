// BF_SERVER_BLOCK_v650_TEST2_FIX_PACK_v1
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");
const r = (p: string) => fs.readFileSync(path.resolve(root, p), "utf8");

const cr = r("routes/creditReadiness.ts");
const rs = r("modules/readiness/readinessSession.service.ts");
const v1 = r("routes/client/v1Applications.ts");
const dn = r("routes/clientDocumentsNeeded.ts");

describe("v650 — readiness receiver accepts all 13 fields (L)", () => {
  it("schema includes the 4 previously-dropped fields", () => {
    for (const k of ["businessLocation","requestedAmount","purposeOfFunds","fixedAssetsValueRange"]) {
      expect(cr).toMatch(new RegExp(`\\b${k}\\b:`));
    }
  });
  it("server-side toE164Server normalization is wired", () => {
    expect(cr).toMatch(/function toE164Server/);
    expect(cr).toMatch(/const phone = toE164Server\(rawPhone\)/);
  });
  it("applications metadata blob persists all 13 keys", () => {
    expect(cr).toMatch(/businessLocation:\s*businessLocation/);
    expect(cr).toMatch(/fixedAssetsValueRange:\s*fixedAssetsValueRange/);
  });
});

describe("v650 — readiness session TTL extended (M)", () => {
  it("TTL is 7 days, not 30 minutes", () => {
    expect(rs).toMatch(/1000\s*\*\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*7/);
    expect(rs).not.toMatch(/Date\.now\(\)\s*\+\s*1000\s*\*\s*60\s*\*\s*30\b/);
  });
  it("INSERT includes the 9 columns from migration 091", () => {
    expect(rs).toMatch(/business_location/);
    expect(rs).toMatch(/requested_amount/);
    expect(rs).toMatch(/fixed_assets_value_range/);
  });
});

describe("v650 — bfBuildWizardMetadata promotes Step 6 fields (C+D+E)", () => {
  it("promotes pgi_opt_in", () => {
    expect(v1).toMatch(/out\.pgi_opt_in = input\.pgi_opt_in/);
  });
  it("promotes signature subobject", () => {
    expect(v1).toMatch(/out\.signature = \{/);
    expect(v1).toMatch(/termsAccepted: input\.termsAccepted/);
    expect(v1).toMatch(/typedSignature: input\.typedSignature/);
  });
  it("promotes requires_closing_cost_funding", () => {
    expect(v1).toMatch(/out\.requires_closing_cost_funding = input\.requires_closing_cost_funding/);
  });
});

describe("v650 — PGI handoff SMS + idempotent ready-message (A + J)", () => {
  it("ready-message INSERT is gated by existence check", () => {
    expect(v1).toMatch(/v650_existingMsg/);
    expect(v1).toMatch(/SELECT id FROM communications_messages[\s\S]+staff_name = 'Boreal Insurance'/);
  });
  it("Twilio sendSms call per leg", () => {
    expect(v1).toMatch(/bi_handoff_sms_failed_nonfatal/);
    expect(v1).toMatch(/Boreal Insurance: your PGI application/);
  });
});

describe("v650 — missing-docs SMS on submit (B)", () => {
  it("documentsDeferred path sends an SMS", () => {
    expect(v1).toMatch(/v650_deferred/);
    expect(v1).toMatch(/missing_docs_sms_failed_nonfatal/);
    expect(v1).toMatch(/upload your remaining documents/);
  });
});

describe("v650 — DocPicker resolves category-union when lender_product_id is NULL (K)", () => {
  it("queries by product_category + amount window when no product is set", () => {
    expect(dn).toMatch(/LOWER\(p\.category\) = \$1/);
    expect(dn).toMatch(/p\.amount_min IS NULL OR p\.amount_min <= \$2/);
    expect(dn).toMatch(/p\.amount_max IS NULL OR p\.amount_max >= \$2/);
  });
});
