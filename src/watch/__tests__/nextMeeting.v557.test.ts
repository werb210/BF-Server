// BF_SERVER_BLOCK_v557_WATCH_NEXT_MEETING
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __clearNextMeetingCache, nextMeetingFor, pickNextMeeting } from "../nextMeeting.js";

const now = new Date("2026-09-26T15:00:00Z");
beforeEach(() => __clearNextMeetingCache());

describe("v557 next meeting on the Watch face", () => {
  it("takes the first real upcoming meeting", () => {
    const events = [
      { subject: "Past", start: { dateTime: "2026-09-26T14:00:00.0000000" } },
      { subject: "Cancelled", isCancelled: true, start: { dateTime: "2026-09-26T16:00:00.0000000" } },
      { subject: "Holiday", isAllDay: true, start: { dateTime: "2026-09-27T00:00:00.0000000" } },
      { subject: "Focus time", showAs: "free", start: { dateTime: "2026-09-26T16:30:00.0000000" } },
      { subject: " ABC Manufacturing ", start: { dateTime: "2026-09-26T17:00:00.0000000" } },
    ];
    expect(pickNextMeeting(events, now)).toEqual({ title: "ABC Manufacturing", startsAt: "2026-09-26T17:00:00.000Z" });
  });
  it("nothing upcoming, or no subject", () => {
    expect(pickNextMeeting([], now)).toBeNull();
    expect(pickNextMeeting([{ subject: "", start: { dateTime: "2026-09-26T18:00:00Z" } }], now)?.title).toBe("Meeting");
  });
  it("caches per user and never throws", async () => {
    const fetchEvents = vi.fn(async () => [{ subject: "Call", start: { dateTime: "2026-09-26T16:00:00" } }]);
    const deps = { fetchEvents, now: () => now };
    expect((await nextMeetingFor("u1", deps))?.title).toBe("Call");
    await nextMeetingFor("u1", deps);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    const broken = { fetchEvents: vi.fn(async () => { throw new Error("graph_401"); }), now: () => now };
    expect(await nextMeetingFor("u2", broken)).toBeNull();
  });
  it("rides along on the face snapshot", () => {
    const snap = readFileSync("src/watch/snapshotRoutes.ts", "utf-8");
    expect(snap).toContain("const nextMeeting = await nextMeetingFor(userId).catch(() => null);");
    expect(snap).toContain("      nextMeeting,");
  });
});
