// BF_SERVER_MEETING_ROOMS_v736
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isOpen, oneTapDial, inviteText, conferenceName } from "../services/meetingRooms.js";
import { joinPageHtml, icsFor } from "../routes/meetings.js";

const room: any = { id: "11111111-1111-4111-8111-111111111111", code: "482913", slug: "abc123def456", title: "Desklinx <review>", host_user_id: null, application_id: null, contact_id: null, starts_at: "2026-10-06T16:00:00Z", duration_min: 60, status: "scheduled" };

describe("meeting rooms", () => {
  it("are open from 15 minutes before to 2 hours after they end, and never when cancelled", () => {
    expect(isOpen(room, new Date("2026-10-06T15:44:00Z"))).toBe(false);
    expect(isOpen(room, new Date("2026-10-06T15:46:00Z"))).toBe(true);
    expect(isOpen(room, new Date("2026-10-06T18:59:00Z"))).toBe(true);
    expect(isOpen(room, new Date("2026-10-06T19:01:00Z"))).toBe(false);
    expect(isOpen({ ...room, status: "cancelled" }, new Date("2026-10-06T16:10:00Z"))).toBe(false);
  });
  it("one tap dials the 866, option 3, then the code", () => {
    expect(oneTapDial("482913")).toBe("+18666318939,,3,,,482913#");
    expect(conferenceName(room.id)).toBe("boreal-meet-" + room.id);
  });
  it("the invite and join page give the number, option and code, with the title escaped", () => {
    expect(inviteText(room)).toContain("call (866) 631-8939, press 3, then enter access code 482913");
    const html = joinPageHtml(room);
    expect(html).toContain("Desklinx &lt;review&gt;");
    expect(html).toContain('<div class="code">482913</div>');
    expect(joinPageHtml(null)).toContain("This meeting isn't available");
  });
  it("produces a calendar file", () => {
    const ics = icsFor(room);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20261006T160000Z");
    expect(ics).toContain("code 482913");
  });
  it("the 866 greeting offers option 3 and the code steps join the conference", () => {
    const r = readFileSync("src/routes/reception.ts", "utf8");
    expect(r).toContain("To join a scheduled meeting, press 3.");
    expect(r).toContain('if (d === "3" || /meeting|conference/.test(s))');
    expect(r).toContain("dial.conference({ startConferenceOnEnter: true");
  });
});
