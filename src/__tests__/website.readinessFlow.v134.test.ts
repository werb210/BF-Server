// BF_SERVER_BLOCK_v134_READINESS_FLOW_FIX_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_BLOCK_v134_READINESS_FLOW_FIX_v1", () => {
  const websiteCtl = readFileSync(
    join(__dirname, "..", "modules", "website", "website.controller.ts"),
    "utf8"
  );
  const clientIdx = readFileSync(
    join(__dirname, "..", "routes", "client", "index.ts"),
    "utf8"
  );

  it("anchor present in website.controller.ts", () => {
    expect(websiteCtl).toContain("BF_SERVER_BLOCK_v134_READINESS_FLOW_FIX_v1");
  });

  it("anchor present in client/index.ts", () => {
    expect(clientIdx).toContain("BF_SERVER_BLOCK_v134_READINESS_FLOW_FIX_v1");
  });

  it("(A) draft application metadata casts $3 and $4 to text", () => {
    expect(websiteCtl).toContain("'readiness_email', $3::text");
    expect(websiteCtl).toContain("'readiness_phone', $4::text");
  });

  it("(A) draft application INSERT captures id via RETURNING", () => {
    expect(websiteCtl).toMatch(/INSERT INTO applications[\s\S]*?RETURNING id/);
    expect(websiteCtl).toMatch(/draftApplicationId\s*[:=]/);
  });

  it("(B) continuation row gets linked to draft application", () => {
    expect(websiteCtl).toMatch(
      /UPDATE application_continuations[\s\S]*?SET converted_application_id/
    );
    expect(websiteCtl).toContain("converted_application_id IS NULL");
  });

  it("(C) /readiness-prefill no longer queries readiness_sessions.id directly with a hex token", () => {
    const idxRoute = clientIdx.indexOf('"/readiness-prefill"');
    expect(idxRoute).toBeGreaterThan(-1);
    const routeBlock = clientIdx.slice(idxRoute, idxRoute + 4000);
    expect(routeBlock).not.toContain(
      "from readiness_sessions where id = $1 and is_active"
    );
    expect(routeBlock).toContain("application_continuations");
    expect(routeBlock).toContain("rs.id::text = $1");
    expect(routeBlock).toContain("rs.crm_lead_id");
  });

  it("(C) /readiness-prefill keeps the existing phone-based lookup branch", () => {
    expect(clientIdx).toContain("regexp_replace(coalesce(phone, '')");
  });
});
