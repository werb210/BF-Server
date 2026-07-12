import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const meetings = readFileSync(join(process.cwd(), "src/routes/crm/meetings.ts"), "utf8");
const migPath = join(process.cwd(), "migrations/2026_07_12_teams_meetings.sql");

describe("BF_SERVER_TEAMS_MEETINGS_v1", () => {
  it("ships an idempotent migration", () => {
    expect(existsSync(migPath)).toBe(true);
    const sql = readFileSync(migPath, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS teams_meetings");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
  });

  it("extends the EXISTING meeting route rather than duplicating it", () => {
    expect(meetings).toContain("BF_SERVER_TEAMS_MEETING_LINK_v1");
    expect(meetings).toContain("BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1");
    expect(meetings).toContain("INSERT INTO teams_meetings");
  });

  it("captures the organizer UPN, which the transcript API requires", () => {
    expect(meetings).toContain("userPrincipalName");
    expect(meetings).toContain("organizerUpn");
  });

  it("only registers a teams_meeting for real online meetings", () => {
    expect(meetings).toContain("if (wantsOnline && graphId)");
  });
});
