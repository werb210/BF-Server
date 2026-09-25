// BF_SERVER_BLOCK_v493_MAYA_DATES_OWNER_BRIEFING
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");

describe("v493 Maya dates, owner, briefing", () => {
  it("summary carries start date, submitted date and owner", () => {
    expect(src).toContain("created_at, submitted_at, owner_user_id::text AS owner_user_id, -- BF_SERVER_BLOCK_v493");
    expect(src).toContain("startedAt: app.created_at ?? null,");
    expect(src).toContain('owner: owner ?? "unassigned",');
  });
  it("no read of the empty application_required_documents table remains", () => {
    expect(src).not.toMatch(/(FROM|JOIN) application_required_documents/);
  });
});
