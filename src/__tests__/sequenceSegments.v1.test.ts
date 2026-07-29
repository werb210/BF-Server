// BF_SERVER_SEQUENCE_SEGMENTS_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");

// Slice the HANDLER only. The comment above it names SMS_ELIGIBLE_SQL when
// explaining what was wrong, which would defeat the "not.toContain" below.
const segment = src.slice(src.indexOf('router.get("/segments", requireAuth'), src.indexOf('router.get("/sequences", requireAuth'));

describe("sequence audience segments", () => {
  it("counts anyone reachable by email OR sms, not just textable contacts", () => {
    expect(segment).toContain("COALESCE(c.email,'') <> '' OR COALESCE(c.phone,'') <> ''");
    expect(segment).not.toContain("SMS_ELIGIBLE_SQL");
  });
  it("still honours the opt-out flag", () => {
    expect(segment).toContain("COALESCE(c.marketing_opt_out,false) = false");
  });
  it("is silo-scoped like every other segments endpoint", () => {
    expect(segment).toContain("resolveSiloFromRequest(req)");
    expect(segment).toContain("c.silo = $1");
  });
  it("does not disturb the SMS-specific segments endpoint", () => {
    const sms = src.slice(src.indexOf('router.get("/sms/segments"'), src.indexOf('router.post("/sms/send"'));
    expect(sms).toContain("SMS_ELIGIBLE_SQL");
  });
});
