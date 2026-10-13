// BF_SERVER_v796_PEOPLE_CHECK / BF_SERVER_v796_TEST_DETAIL
import { describe, expect, it, vi } from "vitest";
import { normalizeDraftNodes } from "../draftFromText.js";
import { normalizeSettings, validateGraph } from "../graph.js";
import { describeTestAction } from "../graphActions.js";
const ANDREW = "11111111-1111-4111-8111-111111111111";
const TODD = "22222222-2222-4222-8222-222222222222";
const users = [{ id: ANDREW, name: "Andrew Polturak" }, { id: TODD, name: "Todd Werboweski" }];
const trig = [{ type: "contact.created", filters: [], filterLogic: "all" as const }];
describe("drafted people", () => {
  it("maps {{owner_id}} to the owner and a staff name to its id", () => {
    const n = normalizeDraftNodes({
      a: { id: "a", kind: "action", action: "assign_owner", params: { userId: "Andrew Polturak" }, next: "b" },
      b: { id: "b", kind: "action", action: "notify_staff", params: { channel: "email", to: "{{owner_id}}", message: "New lead" }, next: "c" },
      c: { id: "c", kind: "action", action: "create_task", params: { title: "Call", assignee: "{{ owner_id }}" }, next: null },
    }, users);
    expect(n.a.params.userId).toBe(ANDREW);
    expect(n.b.params.to).toBe("owner");
    expect(n.c.params.assignee).toBe("owner");
    expect(validateGraph({ triggers: trig, startNodeId: "a", nodes: n } as any, normalizeSettings({}), null, { users: users.map((u) => u.id) })).toEqual([]);
  });
  it("validation flags a person field that is not the owner or a staff member", () => {
    const nodes = {
      a: { id: "a", kind: "action", action: "assign_owner", params: { userId: "Andrew Polturak" }, next: "b" },
      b: { id: "b", kind: "action", action: "create_task", params: { title: "Call", assignee: "{{owner_id}}" }, next: "c" },
      c: { id: "c", kind: "action", action: "notify_staff", params: { channel: "in_app", to: "33333333-3333-4333-8333-333333333333", message: "Hi" }, next: null },
    };
    const issues = validateGraph({ triggers: trig, startNodeId: "a", nodes } as any, normalizeSettings({}), null, { users: users.map((u) => u.id) });
    expect(issues.map((i) => i.nodeId)).toEqual(["a", "b", "c"]);
  });
});
describe("test-run details", () => {
  const deps = {
    now: () => new Date(),
    query: vi.fn(async (sql: string, p: any[] = []) => {
      if (sql.includes("FROM users WHERE id = $1::uuid")) return { rows: [{ name: p[0] === ANDREW ? "Andrew Polturak" : "Todd Werboweski" }] };
      if (sql.includes("SELECT rr_index FROM automation_rules")) return { rows: [{ rr_index: 1 }] };
      if (sql.includes("FROM users WHERE active = true")) return { rows: [{ id: TODD }, { id: ANDREW }] };
      if (sql.includes("owner_user_id FROM applications")) return { rows: [{ id: TODD }] };
      return { rows: [] };
    }),
  } as any;
  const e = { silo: "BF", rule_id: "r1", contact_id: "c1", application_id: null, context: { first_name: "Pat" } };
  const node = (action: string, params: Record<string, unknown>) => ({ id: "x", kind: "action", action, params, next: null }) as any;
  it("names the tag, the new owner, the next person in turn and the recipient", async () => {
    expect(await describeTestAction(deps, e, node("add_tag", { tag: "missed-call" }), "add_tag")).toBe("would add tag missed-call");
    expect(await describeTestAction(deps, e, node("assign_owner", { userId: ANDREW }), "assign_owner")).toBe("would assign to Andrew Polturak");
    expect(await describeTestAction(deps, e, node("rotate_owner", { userIds: [] }), "rotate_owner")).toBe("would assign to Andrew Polturak (next in turn)");
    expect(await describeTestAction(deps, e, node("notify_staff", { channel: "email", to: "owner", message: "Lead {{first_name}}" }), "x")).toBe("would send an internal email to Todd Werboweski: Lead Pat");
    expect(await describeTestAction(deps, e, node("send_sms", { body: "Hi", kind: "marketing" }), "Hi")).toBe("would run: Hi (marketing text - sent only if they agreed to marketing texts)");
    expect(await describeTestAction(deps, e, node("send_sms", { body: "Hi", kind: "transactional" }), "Hi")).toBeNull();
    expect(await describeTestAction(deps, e, node("create_task", { title: "Call" }), "Call")).toBeNull();
  });
  it("never moves the rotation or writes anything", async () => {
    await describeTestAction(deps, e, node("rotate_owner", { userIds: [] }), "rotate_owner");
    for (const [sql] of deps.query.mock.calls) expect(String(sql)).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/i);
  });
});
