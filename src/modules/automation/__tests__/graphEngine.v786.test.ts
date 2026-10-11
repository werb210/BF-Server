// BF_SERVER_v786_WORKFLOW_GRAPH - the v2 graph engine against an in-memory database.
import { describe, it, expect } from "vitest";
import { dispatchEvent, runEnrollment, toEvent } from "../automationEngine.js";
import { fakeDb, contact, rule } from "./fakeAutomationDb.js";

const tag = (id: string, t: string, next: string | null = null) => ({ id, kind: "action", action: "add_tag", params: { tag: t }, next });
const graph = (startNodeId: string, nodes: any[], triggers: any[] = [{ type: "manual.test", filters: [], filterLogic: "all" }]) =>
  ({ triggers, startNodeId, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) });
const HOUR = 3_600_000;

async function enrollOne(db: ReturnType<typeof fakeDb>, type = "manual.test", data: Record<string, unknown> = {}) {
  const ids = await dispatchEvent(db.deps, { trigger: type, silo: "BF", contactId: "c-1", data });
  return ids;
}

describe("graph engine", () => {
  it("walks nested branches and takes the first matching path", async () => {
    const g = graph("b1", [
      { id: "b1", kind: "branch", branches: [{ id: "hot", label: "Hot lead", logic: "all", conditions: [{ field: "lead_status", op: "eq", value: "hot" }], next: "b2" }], noneNext: "cold" },
      { id: "b2", kind: "branch", branches: [
        { id: "big", label: "Has company", logic: "all", conditions: [{ field: "company_name", op: "is_set" }], next: "a" },
        { id: "any", label: "Anything", logic: "any", conditions: [{ field: "first_name", op: "eq", value: "Pat" }], next: "b" },
      ], noneNext: "c" },
      tag("a", "company_hot"), tag("b", "person_hot"), tag("c", "unknown_hot"), tag("cold", "cold"),
    ]);
    const db = fakeDb({ contacts: [contact({ lead_status: "Hot", company_name: null })], rules: [rule(g)] });
    await enrollOne(db);
    expect(db.state.contacts.get("c-1")!.tags).toEqual(["person_hot"]);
    const e = db.state.enrollments[0];
    expect(e.status).toBe("completed");
    expect(e.path.map((p: any) => p.nodeId)).toEqual(["b1", "b2", "b"]);
    expect(e.path[1].result).toBe("path Anything");
  });

  it("value branch picks the case for the field's value, else the otherwise path", async () => {
    const g = graph("v", [
      { id: "v", kind: "value_branch", field: "lead_status", cases: [{ id: "h", label: "Hot", value: "hot", next: "hot" }, { id: "w", label: "Warm", value: "warm", next: "warm" }], noneNext: "other" },
      tag("hot", "hot"), tag("warm", "warm"), tag("other", "other"),
    ]);
    const warm = fakeDb({ contacts: [contact({ lead_status: "Warm" })], rules: [rule(g)] });
    await enrollOne(warm);
    expect(warm.state.contacts.get("c-1")!.tags).toEqual(["warm"]);
    const none = fakeDb({ contacts: [contact({ lead_status: "Frozen" })], rules: [rule(g)] });
    await enrollOne(none);
    expect(none.state.contacts.get("c-1")!.tags).toEqual(["other"]);
  });

  it("until_event waits, takes the timeout path when nothing happens, and the next path when it does", async () => {
    const g = graph("w", [
      { id: "w", kind: "delay", mode: "until_event", params: { event: "booking.created", timeoutAmount: 2, timeoutUnit: "days" }, next: "booked", timeoutNext: "nudge" },
      tag("booked", "booked"), tag("nudge", "nudge"),
    ]);
    const quiet = fakeDb({ contacts: [contact()], rules: [rule(g)] });
    const [id] = await enrollOne(quiet);
    const e = quiet.state.enrollments[0];
    expect(e.wait_event).toBe("booking.created");
    expect(e.status).toBe("active");
    expect(await runEnrollment(quiet.deps, id!)).toBe("not_due");
    quiet.advance(49 * HOUR);
    expect(await runEnrollment(quiet.deps, id!)).toBe("completed");
    expect(quiet.state.contacts.get("c-1")!.tags).toEqual(["nudge"]);
    expect(quiet.state.stepLog.some((l) => l.node === "w" && l.outcome === "timeout")).toBe(true);

    const busy = fakeDb({ contacts: [contact()], rules: [rule(g)] });
    await enrollOne(busy);
    busy.advance(HOUR);
    await dispatchEvent(busy.deps, { trigger: "booking.created", silo: "BF", contactId: "c-1", data: {} });
    expect(busy.state.contacts.get("c-1")!.tags).toEqual(["booked"]);
    expect(busy.state.enrollments[0].status).toBe("completed");
  });

  it("goto jumps back; delays inside the loop make it safe", async () => {
    const g = graph("t", [tag("t", "ping"), { id: "d", kind: "delay", mode: "duration", params: { amount: 1, unit: "hours" }, next: "back" }, { id: "back", kind: "goto", target: "t" }]);
    g.nodes.t.next = "d";
    const db = fakeDb({ contacts: [contact()], rules: [rule(g)] });
    const [id] = await enrollOne(db);
    db.advance(HOUR + 1000);
    expect(await runEnrollment(db.deps, id!)).toBe("waiting");
    expect(db.state.enrollments[0].path.map((p: any) => p.nodeId)).toEqual(["t", "d", "back", "t", "d"]);
  });

  it("stops at the goal: before a step and on an event for the contact", async () => {
    const g = graph("d", [{ id: "d", kind: "delay", mode: "duration", params: { amount: 1, unit: "days" }, next: "t" }, tag("t", "should_not_happen")]);
    const goal = { logic: "any", conditions: [{ field: "contact_tag", op: "contains", value: "customer" }] };
    const db = fakeDb({ contacts: [contact()], rules: [rule(g, { goal })] });
    const [id] = await enrollOne(db);
    db.state.contacts.get("c-1")!.tags.push("customer");
    db.advance(25 * HOUR);
    expect(await runEnrollment(db.deps, id!)).toBe("goal_reached");
    const e = db.state.enrollments[0];
    expect(e.status).toBe("completed");
    expect(e.goal_reached_at).toBeTruthy();
    expect(db.state.contacts.get("c-1")!.tags).not.toContain("should_not_happen");

    const ev = fakeDb({ contacts: [contact()], rules: [rule(g, { goal: { logic: "all", conditions: [{ field: "sms.replied", op: "eq", value: true }] } })] });
    await enrollOne(ev);
    ev.state.inbound.push({ contact_id: "c-1", created_at: ev.state.clock.toISOString() });
    await dispatchEvent(ev.deps, { trigger: "message.inbound", silo: "BF", contactId: "c-1", data: { channel: "sms" } });
    expect(ev.state.enrollments[0].status).toBe("completed");
    expect(ev.state.enrollments[0].goal_reached_at).toBeTruthy();
  });

  it("holds sends in quiet hours and logs instead of sending in test mode", async () => {
    const g = graph("s", [{ id: "s", kind: "action", action: "send_sms", params: { body: "Hi {{first_name}}", kind: "transactional" }, next: null }]);
    const settings = { reenroll: "always", quietHours: { enabled: true, start: "09:00", end: "20:00", tz: "America/Edmonton" }, unenrollOnGoal: true, testMode: false };
    const night = fakeDb({ contacts: [contact()], rules: [rule(g, { settings })], now: new Date("2026-09-29T04:30:00Z") }); // 22:30 Alberta
    const [id] = await enrollOne(night);
    expect(night.deps.sendSms).not.toHaveBeenCalled();
    expect(new Date(night.state.enrollments[0].next_run_at).toISOString()).toBe("2026-09-29T15:00:00.000Z"); // 09:00 Alberta
    night.advance(11 * HOUR);
    expect(await runEnrollment(night.deps, id!)).toBe("completed");
    expect(night.deps.sendSms).toHaveBeenCalledWith("+17805551212", "Hi Pat");

    const test = fakeDb({ contacts: [contact()], rules: [rule(g, { settings: { ...settings, testMode: true } })], now: new Date("2026-09-29T04:30:00Z") });
    await enrollOne(test);
    expect(test.deps.sendSms).not.toHaveBeenCalled();
    expect(test.state.stepLog.map((l) => l.outcome)).toEqual(["dry_run"]);
    expect(test.state.enrollments[0].status).toBe("completed");
  });

  it("the loop guard fails an enrollment that runs more than 200 steps in a day", async () => {
    const g = graph("t", [tag("t", "spin", "back"), { id: "back", kind: "goto", target: "t" }]);
    const db = fakeDb({ contacts: [contact()], rules: [rule(g)] });
    await enrollOne(db);
    const e = db.state.enrollments[0];
    expect(e.status).toBe("failed");
    expect(e.last_error).toBe("loop_guard");
    expect(db.state.stepLog.filter((l) => l.outcome !== "failed").length).toBe(200);
  });

  it("enrolls only when a trigger's filters pass, only in its own silo, and writes the timeline every step", async () => {
    const g = graph("t", [tag("t", "website")], [{ type: "contact.created", filters: [{ field: "source", op: "in", value: ["website_form"] }], filterLogic: "all" }]);
    const db = fakeDb({ contacts: [contact()], rules: [rule(g), rule(g, { id: "r-bi", silo: "BI" })] });
    expect(await dispatchEvent(db.deps, { trigger: "contact.created", silo: "BF", contactId: "c-1", data: { source: "import" } })).toEqual([]);
    expect(await dispatchEvent(db.deps, { trigger: "contact.created", silo: "BF", contactId: "c-1", data: { source: "website_form" } })).toHaveLength(1);
    expect(db.state.enrollments.map((e) => e.rule_id)).toEqual(["r-1"]);
    expect(db.state.timeline.filter((t) => t.event_type === "automation").map((t) => t.payload.step)).toEqual(["add_tag"]);
  });

  it("re-enrollment never / after_complete", async () => {
    const g = graph("d", [{ id: "d", kind: "delay", mode: "duration", params: { amount: 1, unit: "hours" }, next: null }]);
    const never = fakeDb({ contacts: [contact()], rules: [rule(g, { settings: { reenroll: "never" } })] });
    await enrollOne(never); await enrollOne(never);
    expect(never.state.enrollments).toHaveLength(1);
    const after = fakeDb({ contacts: [contact()], rules: [rule(g, { settings: { reenroll: "after_complete" } })] });
    await enrollOne(after); await enrollOne(after);
    expect(after.state.enrollments).toHaveLength(1);
    after.advance(2 * HOUR);
    await runEnrollment(after.deps, after.state.enrollments[0].id);
    await enrollOne(after);
    expect(after.state.enrollments).toHaveLength(2);
  });

  it("the event bus takes emitAutomationEvent(type, payload) and the older single-object form", () => {
    expect(toEvent("booking.created", { silo: "BF", contactId: "c-1", data: { kind: "phone" } })).toEqual({ trigger: "booking.created", silo: "BF", contactId: "c-1", applicationId: null, fromStage: null, toStage: null, data: { kind: "phone" } });
    const legacy = { trigger: "call.missed", silo: "BF", contactId: "c-1" };
    expect(toEvent(legacy)).toBe(legacy);
  });
});
