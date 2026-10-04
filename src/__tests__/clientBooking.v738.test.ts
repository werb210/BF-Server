// BF_SERVER_CLIENT_BOOKING_v738
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { albertaTime, candidateSlots, overlaps } from "../services/clientBooking.js";

describe("client booking", () => {
  it("converts Alberta wall-clock time to UTC across daylight saving", () => {
    expect(albertaTime(2026, 10, 6, 9).toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(albertaTime(2026, 12, 7, 9).toISOString()).toBe("2026-12-07T15:00:00.000Z"); // BF_SERVER_ALBERTA_TIME_v743 - no fall-back: UTC-6 all year
  });
  it("offers weekday 30-minute slots 9:00-17:00 Alberta time, at least 2 hours out", () => {
    const slots = candidateSlots(new Date("2026-10-06T15:00:00Z"), 7);
    expect(slots[0]!.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(slots.some((s) => s.toISOString() === "2026-10-06T22:30:00.000Z")).toBe(true);
    expect(slots.some((s) => s.toISOString() === "2026-10-06T23:00:00.000Z")).toBe(false);
    expect(slots.some((s) => s.toISOString().startsWith("2026-10-10"))).toBe(false);
  });
  it("a busy block removes the slots it overlaps", () => {
    const busy = [{ start: new Date("2026-10-06T17:15:00Z"), end: new Date("2026-10-06T17:45:00Z") }];
    expect(overlaps(new Date("2026-10-06T17:00:00Z"), busy)).toBe(true);
    expect(overlaps(new Date("2026-10-06T17:30:00Z"), busy)).toBe(true);
    expect(overlaps(new Date("2026-10-06T18:00:00Z"), busy)).toBe(false);
  });
  it("clients can book phone calls and Teams meetings only, with a Teams link for Teams", () => {
    const r = readFileSync("src/routes/clientBooking.ts", "utf8");
    expect(r).toContain('const kind = b.kind === "teams" ? "teams" : b.kind === "phone" ? "phone" : null;');
    const s = readFileSync("src/services/clientBooking.ts", "utf8");
    expect(s).toContain('isOnlineMeeting: input.kind === "teams",');
    expect(s).toContain("/calendar/getSchedule");
  });
});
