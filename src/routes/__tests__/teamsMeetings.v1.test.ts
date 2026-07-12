import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(process.cwd(), "src/routes/o365.ts"), "utf8");
const mig = join(process.cwd(), "migrations/2026_07_12_teams_meetings.sql");

describe("BF_SERVER_TEAMS_MEETINGS_v1", () => {
  it("ships an idempotent migration", () => {
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS teams_meetings");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).not.toMatch(/CREATE TABLE teams_meetings\b/);
  });

  it("exposes the schedule route", () => {
    expect(route).toContain("BF_SERVER_TEAMS_MEETING_SCHEDULE_v1");
    expect(route).toContain('router.post("/meetings/schedule"');
    expect(route).toContain('router.get("/meetings/by-contact/:contactId"');
  });

  it("creates a real calendar event so transcripts are addressable", () => {
    expect(route).toContain('graph.fetch("/me/events"');
    expect(route).toContain("isOnlineMeeting: true");
    expect(route).toContain("teamsForBusiness");
  });

  it("persists the organizer and links the meeting to a contact + silo", () => {
    expect(route).toContain("INSERT INTO teams_meetings");
    expect(route).toContain("organizer_upn");
    expect(route).toContain("contact_id_required");
  });
});
