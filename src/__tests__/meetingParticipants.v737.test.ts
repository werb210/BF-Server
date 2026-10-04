// BF_SERVER_MEETING_PARTICIPANTS_v737
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_PEOPLE } from "../services/meetingRooms.js";
describe("conference room participants", () => {
  it("caps a room at 10 people including the host", () => {
    expect(MAX_PEOPLE).toBe(10);
    const s = readFileSync("src/services/meetingRooms.ts", "utf8");
    expect(s).toContain("let room_left = MAX_PEOPLE - hostCounts - existing.length;");
  });
  it("searches CRM contacts and staff by name, email, phone or company", () => {
    const s = readFileSync("src/services/meetingRooms.ts", "utf8");
    expect(s).toContain("(name ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR company_name ILIKE $1 OR phone ILIKE $1)");
    expect(s).toContain("FROM users");
  });
  it("has routes to search, add and remove people, and invites at creation", () => {
    const r = readFileSync("src/routes/meetings.ts", "utf8");
    for (const x of ['router.get("/people"', 'router.post("/:id/participants"', 'router.delete("/:id/participants/:pid"', "await notifyMeeting(room"]) expect(r).toContain(x);
  });
});
