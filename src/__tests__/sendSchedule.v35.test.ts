// BF_SERVER_SEND_LATER_v35
import { describe, expect, it } from "vitest";
import {
  MAX_LEAD_DAYS,
  MIN_LEAD_MINUTES,
  resolveScheduledAt,
  SendScheduleError,
} from "../services/sendSchedule.js";

const NOW = new Date("2026-08-08T18:00:00.000Z");
const HOLD = 5;

describe("resolveScheduledAt", () => {
  it("keeps today's behaviour when nothing is requested", () => {
    const r = resolveScheduledAt(undefined, HOLD, NOW);
    expect(r.scheduled).toBe(false);
    expect(r.at.toISOString()).toBe("2026-08-08T18:05:00.000Z");
  });

  it("treats a blank string as nothing requested", () => {
    for (const blank of ["", "   ", null]) {
      expect(resolveScheduledAt(blank, HOLD, NOW).scheduled).toBe(false);
    }
  });

  it("honours a future instant exactly", () => {
    const r = resolveScheduledAt("2026-08-12T14:30:00.000Z", HOLD, NOW);
    expect(r.scheduled).toBe(true);
    expect(r.coerced).toBe(false);
    expect(r.at.toISOString()).toBe("2026-08-12T14:30:00.000Z");
  });

  it("refuses an unparseable date rather than blasting immediately", () => {
    expect(() => resolveScheduledAt("next tuesday", HOLD, NOW)).toThrow(SendScheduleError);
    try {
      resolveScheduledAt("2026-13-45", HOLD, NOW);
    } catch (err) {
      expect((err as SendScheduleError).code).toBe("invalid_send_at");
    }
  });

  it("refuses a date beyond the ceiling, because that is a typo", () => {
    expect(() => resolveScheduledAt("2027-08-08T18:00:00.000Z", HOLD, NOW)).toThrowError(
      expect.objectContaining({ code: "send_at_too_far" }),
    );
  });

  it("accepts a date just inside the ceiling", () => {
    const inside = new Date(NOW.getTime() + (MAX_LEAD_DAYS - 1) * 86_400_000);
    expect(resolveScheduledAt(inside.toISOString(), HOLD, NOW).scheduled).toBe(true);
  });

  it("raises a past time to the hold floor instead of rejecting it", () => {
    const r = resolveScheduledAt("2026-08-01T00:00:00.000Z", HOLD, NOW);
    expect(r.scheduled).toBe(true);
    expect(r.coerced).toBe(true);
    expect(r.at.toISOString()).toBe("2026-08-08T18:05:00.000Z");
  });

  it("never lets a send skip its cancel window", () => {
    const r = resolveScheduledAt("2026-08-08T18:01:00.000Z", HOLD, NOW);
    expect(r.at.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + HOLD * 60_000);
  });

  it("uses the larger of the silo hold and the global minimum", () => {
    const r = resolveScheduledAt(undefined, 0, NOW);
    expect(r.at.toISOString()).toBe(
      new Date(NOW.getTime() + MIN_LEAD_MINUTES * 60_000).toISOString(),
    );
  });
});
