// BF_SERVER_v902_NO_DEAD_AIR_CALLEE - a customer is never left alone on a call the staff member already left.
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { dialPendingCallees, staffGone } from "../voice/outboundCallFlow.js";

const db = (rules: Parameters<typeof answerBySql>[0]) => ({ query: vi.fn(answerBySql(rules)) });
const gone = (conf_status: string | null, staff_legs: number, staff_live: number) =>
  db([[/staff_live/, { rows: [{ conf_status, staff_legs, staff_live }] }]]);

describe("staffGone", () => {
  it("is true once the conference ended or every staff leg left", async () => {
    expect(await staffGone("c1", gone("ended", 1, 1))).toBe(true);
    expect(await staffGone("c1", gone("active", 1, 0))).toBe(true);
  });
  it("is false while a staff leg is on, with no staff rows, or when the lookup fails", async () => {
    expect(await staffGone("c1", gone(null, 1, 1))).toBe(false);
    expect(await staffGone("c1", gone("active", 0, 0))).toBe(false);
    expect(await staffGone("c1", { query: vi.fn(async () => { throw new Error("db down"); }) })).toBe(false);
  });
});

describe("dialPendingCallees", () => {
  it("does not ring the customer when the staff leg already dropped", async () => {
    const dialPstn = vi.fn(async () => ({ callSid: "CA1" }));
    const d = db([
      [/SET status = 'invited'/, { rows: [{ id: "p1", phone_number: "+15405550100", friendly_name: "bf-1", created_by_user_id: "u1" }] }],
      [/staff_live/, { rows: [{ conf_status: "ended", staff_legs: 1, staff_live: 0 }] }],
      [/SET status = 'canceled'/, { rows: [] }],
    ]);
    expect(await dialPendingCallees("c1", { db: d, dialPstn, callerId: async () => "+18255550100" })).toBe(0);
    expect(dialPstn).not.toHaveBeenCalled();
    expect(d.query.mock.calls.some(([s]) => /SET status = 'canceled'/.test(String(s)))).toBe(true);
  });
  it("still rings the customer while the staff member is on", async () => {
    const dialPstn = vi.fn(async () => ({ callSid: "CA1" }));
    const d = db([
      [/SET status = 'invited'/, { rows: [{ id: "p1", phone_number: "+15405550100", friendly_name: "bf-1", created_by_user_id: "u1" }] }],
      [/staff_live/, { rows: [{ conf_status: "active", staff_legs: 1, staff_live: 1 }] }],
    ]);
    expect(await dialPendingCallees("c1", { db: d, dialPstn, callerId: async () => "+18255550100" })).toBe(1);
    expect(dialPstn).toHaveBeenCalledTimes(1);
  });
});
