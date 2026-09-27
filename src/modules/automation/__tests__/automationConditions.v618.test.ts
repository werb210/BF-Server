// BF_SERVER_BLOCK_v616
import { describe, it, expect } from "vitest";
import { conditionsMatch, evaluate, nextAllowedSendTime, renderTokens } from "../conditions.js";
import { stepsOf } from "../automationContext.js";
import { TRIGGERS, ACTIONS, CHECKS } from "../catalog.js";

const NOON = new Date("2026-09-28T18:00:00Z"); // 12:00 in Edmonton

describe("conditions", () => {
  it("evaluates operators, lists and legacy object conditions", () => {
    const ctx = { to_stage: "Offer", requested_amount: 250000, contact_tag: ["VIP", "bf"], source: "Website" };
    expect(evaluate({ field: "to_stage", op: "eq", value: "offer" }, ctx)).toBe(true);
    expect(evaluate({ field: "requested_amount", op: "gte", value: 250000 }, ctx)).toBe(true);
    expect(evaluate({ field: "contact_tag", op: "in", value: ["vip"] }, ctx)).toBe(true);
    expect(evaluate({ field: "source", op: "in", value: ["website", "readiness_check"] }, ctx)).toBe(true);
    expect(evaluate({ field: "reason", op: "is_set" }, ctx)).toBe(false);
    expect(evaluate({ field: "x", op: "bogus", value: 1 }, ctx)).toBe(false);
    expect(conditionsMatch({ toStage: "Offer" }, ctx)).toBe(true);
    expect(conditionsMatch([{ field: "to_stage", op: "eq", value: "Accepted" }], ctx)).toBe(false);
    expect(renderTokens("Hi {{first_name}}{{missing}}", { first_name: "Pat" })).toBe("Hi Pat");
  });

  it("holds outward messages to 9am-8pm Edmonton", () => {
    expect(nextAllowedSendTime(NOON)).toBeNull();
    const late = nextAllowedSendTime(new Date("2026-09-29T04:30:00Z")); // 22:30 Edmonton
    expect(late?.toISOString()).toBe("2026-09-29T15:00:00.000Z"); // 09:00 Edmonton
  });
});

describe("catalog and legacy rules", () => {
  it("lists the phase-1 triggers, actions and checks", () => {
    expect(TRIGGERS.map((t) => t.key)).toEqual(["application.stage_changed", "document.rejected", "message.inbound", "call.missed", "contact.created"]);
    expect(ACTIONS.map((a) => a.key)).toContain("wait");
    expect(CHECKS.map((c) => c.key)).toContain("still_in_stage");
  });
  it("turns legacy actions into steps", () => {
    expect(stepsOf({ steps: [], actions: [{ type: "send_push", title: "t" }, { type: "create_task", dueDays: 2 }] })).toEqual([{ type: "notify_client", title: "t" }, { type: "create_task", dueDays: 2, dueHours: 48 }]);
  });
});
