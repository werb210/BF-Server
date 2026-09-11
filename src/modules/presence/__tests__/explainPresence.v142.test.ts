import { describe, it, expect } from "vitest";
import {
  explainPresence,
  explainTeam,
  withinBusinessHours,
  localHourIn,
  type PresenceRow,
} from "../explainPresence.js";

const NOON_MDT = new Date("2026-09-11T18:00:00Z"); // 12:00 in Edmonton (MDT, UTC-6)
const SEVEN_PM_MDT = new Date("2026-09-11T01:00:00Z"); // 19:00 previous day in Edmonton
const JANUARY_NOON = new Date("2026-01-15T19:00:00Z"); // 12:00 in Edmonton (MST, UTC-7)

function row(over: Partial<PresenceRow> = {}): PresenceRow {
  return {
    user_id: "u1",
    twilio_identity: "u1",
    status: "available",
    last_heartbeat: new Date(NOON_MDT.getTime() - 60_000),
    manual_busy: false,
    on_call: false,
    in_meeting: false,
    ...over,
  };
}

describe("BF_SERVER_PRESENCE_EXPLAIN_v142", () => {
  it("reports a healthy staff member as reachable", () => {
    const e = explainPresence(row(), NOON_MDT);
    expect(e.reachable).toBe(true);
    expect(e.reason).toBe("available");
  });

  it("respects daylight saving - noon is inside hours in both summer and winter", () => {
    expect(withinBusinessHours(NOON_MDT)).toBe(true);
    expect(withinBusinessHours(JANUARY_NOON)).toBe(true);
    expect(localHourIn(NOON_MDT)).toBe(12);
    expect(localHourIn(JANUARY_NOON)).toBe(12);
  });

  it("blocks outside business hours even with a live heartbeat", () => {
    const e = explainPresence(
      row({ last_heartbeat: new Date(SEVEN_PM_MDT.getTime() - 30_000) }),
      SEVEN_PM_MDT,
    );
    expect(e.reachable).toBe(false);
    expect(e.reason).toBe("outside_business_hours");
    expect(e.message).toContain("makes no difference");
  });

  it("explains a stale heartbeat with how long ago it was", () => {
    const e = explainPresence(
      row({ last_heartbeat: new Date(NOON_MDT.getTime() - 20 * 60_000) }),
      NOON_MDT,
    );
    expect(e.reason).toBe("stale_heartbeat");
    expect(e.message).toContain("20 minutes ago");
    expect(e.heartbeatAgeMinutes).toBeCloseTo(20, 0);
  });

  it("explains a user who has never checked in", () => {
    const e = explainPresence(row({ last_heartbeat: null }), NOON_MDT);
    expect(e.reason).toBe("no_heartbeat");
    expect(e.heartbeatAgeMinutes).toBeNull();
  });

  it("a stale heartbeat outranks every busy flag - an offline device cannot be busy", () => {
    const e = explainPresence(
      row({ last_heartbeat: new Date(NOON_MDT.getTime() - 60 * 60_000), on_call: true, manual_busy: true }),
      NOON_MDT,
    );
    expect(e.reason).toBe("stale_heartbeat");
  });

  it("names each busy reason separately", () => {
    expect(explainPresence(row({ manual_busy: true }), NOON_MDT).reason).toBe("manual_busy");
    expect(explainPresence(row({ on_call: true }), NOON_MDT).reason).toBe("on_call");
    expect(explainPresence(row({ in_meeting: true }), NOON_MDT).reason).toBe("in_meeting");
  });

  it("flags a missing twilio identity, which routes to a device nobody is listening on", () => {
    const e = explainPresence(row({ twilio_identity: null }), NOON_MDT);
    expect(e.reason).toBe("no_twilio_identity");
    expect(e.message).toContain("voice token");
  });

  it("tolerates a heartbeat stored as a string", () => {
    const e = explainPresence(row({ last_heartbeat: "2026-09-11T17:59:30.000Z" }), NOON_MDT);
    expect(e.reachable).toBe(true);
  });

  it("tolerates a junk heartbeat value without throwing", () => {
    const e = explainPresence(row({ last_heartbeat: "not a date" }), NOON_MDT);
    expect(e.reachable).toBe(false);
    expect(e.reason).toBe("no_heartbeat");
  });

  it("summarises why a whole team was unreachable", () => {
    const team = explainTeam(
      [
        row({ user_id: "a", last_heartbeat: new Date(SEVEN_PM_MDT.getTime() - 30_000) }),
        row({ user_id: "b", last_heartbeat: new Date(SEVEN_PM_MDT.getTime() - 30_000) }),
        row({ user_id: "c", last_heartbeat: null }),
      ],
      SEVEN_PM_MDT,
    );
    expect(team.reachableCount).toBe(0);
    expect(team.total).toBe(3);
    expect(team.blockingReasons[0]).toEqual({ reason: "outside_business_hours", count: 2 });
    expect(team.staff.length).toBe(3);
  });

  it("counts reachable staff when some are available", () => {
    const team = explainTeam([row({ user_id: "a" }), row({ user_id: "b", on_call: true })], NOON_MDT);
    expect(team.reachableCount).toBe(1);
    expect(team.blockingReasons).toEqual([{ reason: "on_call", count: 1 }]);
  });
});
