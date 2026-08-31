// BF_SERVER_PER_LENDER_IVES_v144
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
const signing = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");
const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "..", "migrations", "2026_08_30_v144_lender_ives.sql"), "utf-8");

describe("IVES details belong to the lender", () => {
  it.each([
    "ives_participant_name", "ives_participant_id", "ives_sor_mailbox_id",
    "ives_street", "ives_city", "ives_state", "ives_zip",
  ])("%s is on the lenders table", (col) => {
    expect(mig).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
  });
  it("is idempotent and creates nothing", () => {
    expect((mig.match(/IF NOT EXISTS/g) || []).length).toBe(7);
    expect(mig).not.toContain("CREATE TABLE");
    expect(mig).not.toContain("pg_trgm");
  });
  it("only alters a table that exists", () => expect(mig).toContain("ALTER TABLE lenders"));
});

describe("the builder prefers the lender over the environment", () => {
  it("takes an IVES participant", () => {
    expect(builder).toContain("ives?: IvesParticipant");
    expect(builder).toContain("s(args.ives?.participantName) || s(process.env.SBA_IVES_PARTICIPANT_NAME)");
  });
  it("still works from env alone, for a single-lender setup", () => expect(builder).toContain("process.env.SBA_IVES_PARTICIPANT_ID"));
  it("names the lender when it cannot build", () => expect(builder).toContain("lenderId: args.ives?.lenderId ?? null"));
});

describe("one authorisation per lender", () => {
  it("loops the selected IVES lenders", () => expect(signing).toContain("for (const ives of ivesLenders)"));
  it("only selects lenders that actually have all three IVES fields", () => {
    expect(signing).toContain("COALESCE(l.ives_participant_name,'') <> ''");
    expect(signing).toContain("COALESCE(l.ives_sor_mailbox_id,'')   <> ''");
  });
  it("names the file for the lender so they are distinguishable", () => expect(signing).toContain("irs-4506c-owner${owner.index}-${slug}-${applicationId}.pdf"));
  it("records which lenders each envelope covers", () => expect(signing).toContain("ives4506cLenderIds"));
  it("falls back to one env-based form when no IVES lender is selected", () => {
    expect(signing).toContain("if (ivesLenders.length === 0)");
    expect(signing).toContain('lendersCovered.add("__env__")');
  });
});

describe("a package with no authorisation no longer ships", () => {
  it("the gate blocks it", () => {
    expect(signing).toContain("sba_dispatch_blocked_no_4506c");
    const i = signing.indexOf("sba_dispatch_blocked_no_4506c");
    expect(signing.slice(i, i + 400)).toContain("return false;");
  });
  it("says what to do about it", () => expect(signing).toContain("Set the IVES participant fields on the selected lender"));
  it("does not block an application that has no envelopes at all", () => expect(signing).toContain("envelopes.length > 0 && !anyAuthorisation"));
});
