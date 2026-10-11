// BF_SERVER_v786_WORKFLOW_GRAPH - v1 -> v2 conversion, validation, conditions, time helpers, library.
import { describe, it, expect, vi } from "vitest";
import { convertV1Rule, validateGraph, evaluateCondition, conditionsPass, nextTimeOfDay, quietHoursRelease, normalizeSettings } from "../graph.js";
import { convertV1Rules } from "../graphEngine.js";
import { libraryItems, catalogStatic } from "../library.js";

describe("v1 -> v2 conversion", () => {
  const offer = {
    trigger_type: "application.stage_changed", conditions: [{ field: "to_stage", op: "eq", value: "Offer" }], reenroll: "always", test_mode: false,
    steps: [{ type: "wait", amount: 48, unit: "hours" }, { type: "check", check: "still_in_stage" }, { type: "notify_client", title: "Waiting", body: "Hi {{first_name}}" }, { type: "create_task", title: "Call", taskType: "CALL", priority: "HIGH", dueHours: 4, assignTo: "owner" }],
  };

  it("turns trigger + conditions into a filtered trigger and steps into a linear chain", () => {
    const { graph, settings, goal } = convertV1Rule(offer);
    expect(graph.triggers).toEqual([{ type: "application.stage_changed", filters: [{ field: "to_stage", op: "eq", value: "Offer" }], filterLogic: "all" }]);
    expect(graph.startNodeId).toBe("n1");
    expect(graph.nodes.n1).toEqual({ id: "n1", kind: "delay", mode: "duration", params: { amount: 48, unit: "hours" }, next: "n2" });
    // a v1 "check" becomes a branch whose otherwise path ends
    expect(graph.nodes.n2).toMatchObject({ kind: "branch", noneNext: null, branches: [{ conditions: [{ field: "check.still_in_stage", op: "eq", value: true }], next: "n3" }] });
    expect(graph.nodes.n3).toMatchObject({ kind: "action", action: "notify_client", next: "n4" });
    expect(graph.nodes.n4).toMatchObject({ kind: "action", action: "create_task", params: { type: "CALL", priority: "HIGH", dueInHours: 4, assignee: "owner" }, next: null });
    expect(settings.reenroll).toBe("always");
    expect(goal).toBeNull();
    expect(validateGraph(graph, settings, goal)).toEqual([]);
  });

  it("maps legacy object conditions, actions, round robin, and keeps website leads matching", () => {
    const legacy = convertV1Rule({ trigger_type: "application.stage_changed", conditions: { toStage: "Accepted" }, actions: [{ type: "send_push", title: "t", body: "b" }, { type: "create_task", title: "x", dueDays: 2 }] });
    expect(legacy.graph.triggers[0]!.filters).toEqual([{ field: "to_stage", op: "eq", value: "Accepted" }]);
    expect(legacy.graph.nodes.n1).toMatchObject({ action: "notify_client" });
    expect(legacy.graph.nodes.n2).toMatchObject({ action: "create_task", params: { dueInHours: 48 } });
    const lead = convertV1Rule({ trigger_type: "contact.created", conditions: [{ field: "source", op: "in", value: ["website", "readiness_check"] }], steps: [{ type: "assign_owner", mode: "round_robin", userIds: [] }] });
    expect(lead.graph.triggers[0]!.filters![0]!.value).toEqual(["website", "readiness_check", "website_form"]);
    expect(lead.graph.nodes.n1).toMatchObject({ action: "rotate_owner", params: { userIds: [] } });
  });

  it("converts every rule with no graph on startup, idempotently, leaving steps untouched", async () => {
    const updates: any[] = [];
    const q = vi.fn(async (sql: string, p: any[] = []) => {
      if (sql.includes("FROM automation_rules WHERE graph IS NULL")) return { rows: [{ id: "r-1", ...offer }] };
      if (sql.startsWith("UPDATE automation_rules SET graph")) { updates.push({ sql, p }); return { rows: [], rowCount: 1 }; }
      return { rows: [] };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await convertV1Rules(q as any)).toBe(1);
    expect(updates[0].sql).toContain("WHERE id = $1::uuid AND graph IS NULL");
    expect(updates[0].sql).toContain("schema_version = 2");
    expect(updates[0].sql).not.toContain("steps =");
    expect(JSON.parse(updates[0].p[1]).startNodeId).toBe("n1");
  });
});

describe("validation", () => {
  it("reports issues per node", () => {
    const issues = validateGraph({
      triggers: [{ type: "contact.created", filters: [] }, { type: "nope" }],
      startNodeId: "a",
      nodes: {
        a: { id: "a", kind: "action", action: "send_email", params: {}, next: "missing" },
        b: { id: "b", kind: "action", action: "webhook", params: { url: "http://x.example.com" }, next: null },
        c: { id: "c", kind: "delay", mode: "until_event", params: { event: "booking.created", timeoutAmount: 0 }, next: null, timeoutNext: null },
        d: { id: "d", kind: "goto", target: "zzz" },
        l1: { id: "l1", kind: "action", action: "add_tag", params: { tag: "x" }, next: "l2" },
        l2: { id: "l2", kind: "goto", target: "l1" },
      },
    } as any, {}, null, { templates: { email: [], sms: [] } });
    const by = (id: string | null) => issues.filter((i) => i.nodeId === id).map((i) => i.message);
    expect(by("trigger:1")).toEqual(["unknown trigger nope"]);
    expect(by("a")).toEqual(["pick an email template", "next points to a step that does not exist"]);
    expect(by("b")).toEqual(["webhook URL must start with https://"]);
    expect(by("c")).toEqual(["the timeout must be more than zero"]);
    expect(by("d")).toEqual(["go to points to a step that does not exist"]);
    expect(by("l1")).toEqual(["this loop has no delay in it"]);
  });

  it("conditions: every operator, engagement fields and changed_to", () => {
    const ctx = { lead_status: "Hot", amount: 5, tags: ["vip"], field: "lead_status", to: "Hot", "email.opened": true };
    expect(evaluateCondition({ field: "lead_status", op: "eq", value: "hot" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "lead_status", op: "neq", value: "cold" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "in", value: ["vip", "x"] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "not_in", value: ["x"] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "amount", op: "gt", value: 4 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "amount", op: "lte", value: 4 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: "tags", op: "contains", value: "VIP" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "not_contains", value: "vip" }, ctx)).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "is_not_set" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "lead_status", op: "changed_to", value: "hot" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "email.opened", op: "eq", value: true }, ctx)).toBe(true);
    expect(conditionsPass([{ field: "amount", op: "gt", value: 10 }, { field: "lead_status", op: "eq", value: "hot" }], "any", ctx)).toBe(true);
    expect(conditionsPass([{ field: "amount", op: "gt", value: 10 }, { field: "lead_status", op: "eq", value: "hot" }], "all", ctx)).toBe(false);
  });

  it("time: until_time on weekdays and quiet hours in Alberta time", () => {
    const fri = new Date("2026-10-09T18:00:00Z"); // Friday 12:00 Alberta
    expect(nextTimeOfDay(fri, "09:30", [1], "America/Edmonton").toISOString()).toBe("2026-10-12T15:30:00.000Z"); // Monday 09:30
    expect(nextTimeOfDay(fri, "13:00", null, "America/Edmonton").toISOString()).toBe("2026-10-09T19:00:00.000Z");
    const q = normalizeSettings({}).quietHours;
    expect(quietHoursRelease(fri, q)).toBeNull();
    expect(quietHoursRelease(new Date("2026-10-10T03:00:00Z"), q)!.toISOString()).toBe("2026-10-10T15:00:00.000Z");
    expect(quietHoursRelease(new Date("2026-10-10T03:00:00Z"), { ...q, enabled: false })).toBeNull();
  });
});

describe("library and catalog", () => {
  it("has the 4 system automations plus booked call follow-up and no reply after 3 days, all valid", () => {
    const items = libraryItems();
    expect(items.map((i) => i.name)).toEqual([
      "Funded: thank you, referral ask, insurance", "Missed inbound call", "New website lead", "Offer not accepted after 48 hours",
      "Booked call follow-up", "No reply after 3 days",
    ]);
    for (const i of items) expect(validateGraph(i.graph, i.settings, i.goal)).toEqual([]);
  });
  it("lists every trigger and action with labels and groups", () => {
    const c = catalogStatic();
    expect(c.triggers.map((t) => t.type)).toContain("date.relative");
    expect(c.triggers.every((t) => t.label && t.group && Array.isArray(t.filterFields))).toBe(true);
    expect(c.actions.map((a) => a.action)).toEqual(["send_email", "send_sms", "notify_client", "notify_staff", "team_post", "rotate_owner", "assign_owner", "create_task", "add_note", "set_contact_field", "set_application_stage", "add_tag", "remove_tag", "add_to_list", "remove_from_list", "webhook", "enroll_workflow"]);
    expect(c.fields.find((f) => f.key === "email.opened")?.type).toBe("boolean");
  });
});
