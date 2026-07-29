import { describe, expect, it } from "vitest";
import { nextSendableAt, scheduleAfter } from "../services/sequenceSchedule.js";

describe("sequence business-hour scheduling", () => {
  it("only moves a deadline forward", () => {
    const requested = new Date("2026-07-31T21:30:00.000Z"); // Friday 15:30 Edmonton
    expect(nextSendableAt(requested, 9, 17)).toEqual(requested);
  });

  it("moves a weekend deadline to Monday in Edmonton", () => {
    const saturday = new Date("2026-08-01T16:00:00.000Z");
    const result = nextSendableAt(saturday, 9, 17);
    expect(result.toISOString()).toBe("2026-08-03T15:00:00.000Z");
    expect(result.getTime()).toBeGreaterThanOrEqual(saturday.getTime());
  });

  it("applies waits before adjusting to the window", () => {
    const friday = new Date("2026-07-31T22:30:00.000Z");
    expect(scheduleAfter(120, 9, 17, friday).toISOString()).toBe("2026-08-03T15:00:00.000Z");
  });
});
