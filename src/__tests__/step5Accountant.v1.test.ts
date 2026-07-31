import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const route = readFileSync(fileURLToPath(new URL("../routes/client/accountant.ts", import.meta.url)), "utf-8");
const index = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
const registry = readFileSync(fileURLToPath(new URL("../routes/routeRegistry.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_STEP5_ACCOUNTANT_v1", () => {
  it("is mounted under the client router", () => {
    expect(index).toContain("accountantRouter");
    expect(registry).toContain('path: "/api/client/accountant"');
  });

  it("merges only the cpa slot and never marks the advisors form submitted", () => {
    expect(route).toContain("'{advisors,cpa}'");
    expect(route).not.toContain("submitted_at");
  });

  it("reuses the Stage-2 CRM mirror and its role tag", () => {
    expect(route).toContain("findOrCreateCompanyByNameAndSilo");
    expect(route).toContain("findOrCreateContactByEmailAndCompany");
    expect(route).toContain('"Accountant/advisor"');
  });

  it("requires every field the modal collects", () => {
    expect(route).toContain("accountant_fields_required");
    expect(route).toContain("applicationId_required");
  });

  it("does not let a CRM failure break the capture", () => {
    expect(route).toContain("crm mirror failed");
  });
});
