// BF_SERVER_ADS_ENHANCED_v403
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { customerMatchOperations, normalizePhone, userIdentifiersFor } from "../services/googleAdsEnhanced.js";
import { qualifiedPayload } from "../services/googleAdsLeadSignals.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("enhanced conversions for leads", () => {
  it("sends hashed email and phone only with consent", () => {
    expect(userIdentifiersFor(" Ann@Acme.com ", "(403) 555-1234", true)).toEqual([
      { hashedEmail: sha("ann@acme.com") },
      { hashedPhoneNumber: sha("+14035551234") },
    ]);
    expect(userIdentifiersFor("ann@acme.com", "4035551234", false)).toEqual([]);
    expect(userIdentifiersFor("ann@acme.com", "4035551234", undefined)).toEqual([]);
    expect(userIdentifiersFor("ann@acme.com", null, "true")).toEqual([{ hashedEmail: sha("ann@acme.com") }]);
  });

  it("normalizes North American phones to E.164", () => {
    expect(normalizePhone("403-555-1234")).toBe("+14035551234");
    expect(normalizePhone("+1 (403) 555-1234")).toBe("+14035551234");
    expect(normalizePhone("123")).toBe("");
  });

  it("identifiers ride on qualified, submitted and funded uploads", () => {
    const body: any = qualifiedPayload({
      applicationId: "a", clickId: "G", clickField: "gclid", value: 0,
      at: "2026-09-22T00:00:00Z", userIdentifiers: [{ hashedEmail: "h" }],
    }, "1", "2", "CAD");
    expect(body.conversions[0].userIdentifiers).toEqual([{ hashedEmail: "h" }]);
    const conversions = read("src/services/googleAdsConversions.ts");
    expect(conversions.split("...(p.userIdentifiers?.length ? { userIdentifiers: p.userIdentifiers } : {}), // BF_SERVER_ADS_ENHANCED_v403").length - 1).toBe(2);
    expect(conversions.split("AS ad_consent,").length - 1).toBe(2);
  });
});

describe("Customer Match upload", () => {
  it("is a full weekly refresh: remove everyone, then add the current funded clients", () => {
    const operations: any[] = customerMatchOperations([[{ hashedEmail: "a" }], [{ hashedPhoneNumber: "b" }]]);
    expect(operations[0]).toEqual({ removeAll: true });
    expect(operations[1]).toEqual({ create: { userIdentifiers: [{ hashedEmail: "a" }] } });
    expect(operations).toHaveLength(3);
  });

  it("is opt-in and runs from the hourly worker", () => {
    const service = read("src/services/googleAdsEnhanced.ts");
    expect(service).toContain('GOOGLE_ADS_CUSTOMER_MATCH_ENABLED ?? "").toLowerCase() === "true"');
    expect(service).toContain("COALESCE(c.marketing_opt_out, false) = false");
    expect(read("src/workers/adConversionWorker.ts")).toContain("await syncCustomerMatch();");
  });
});
