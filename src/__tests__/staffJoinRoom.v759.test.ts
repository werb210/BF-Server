// BF_SERVER_STAFF_JOIN_ROOM_v759
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { staffRoomJoinTwiml, conferenceName } from "../services/meetingRooms.js";

const start = new Date("2026-10-05T20:30:00Z");
const room: any = { id: "r1", code: "799151", slug: "2367a2ac98b1", title: "Test", host_user_id: null, application_id: null, contact_id: null, starts_at: start.toISOString(), duration_min: 30, status: "scheduled" };

describe("staff join a meeting room from the calendar", () => {
  it("joins the room's conference, recorded like dial-in callers", async () => {
    const xml = await staffRoomJoinTwiml(room, new Date(start.getTime() + 5 * 60_000));
    expect(xml).toContain("<Conference");
    expect(xml).toContain(conferenceName("r1"));
    expect(xml).toContain('record="record-from-start"');
  });
  it("says when the room is not open yet, and when it does not exist", async () => {
    expect(await staffRoomJoinTwiml(room, new Date(start.getTime() - 60 * 60_000))).toContain("opens 15 minutes before");
    expect(await staffRoomJoinTwiml(null)).toContain("could not be found");
    expect(await staffRoomJoinTwiml({ ...room, status: "cancelled" }, start)).toContain("could not be found");
  });
  it("only a staff browser call (client: identity) with a meeting link takes this path", () => {
    const s = readFileSync("src/routes/webhooks.ts", "utf8");
    expect(s).toContain('if (meetingSlug && from.startsWith("client:")) {');
  });
});
