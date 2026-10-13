// BF_SERVER_v795_DRAFT_REPAIR
// A drafted step whose "kind" is an action name ({"kind":"send_sms"}) is rewritten to an action
// step, so it validates and every step after it stays reachable; the repair round sends the
// problems back to the model.
import { describe, expect, it, vi } from "vitest";
import { draftWorkflowFromText, normalizeDraftNodes } from "../draftFromText.js";
import { validateGraph, normalizeSettings } from "../graph.js";

const reply = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

describe("AI drafter repairs step kinds", () => {
  it("turns an action name used as kind into an action step and keeps the chain", () => {
    const nodes = normalizeDraftNodes({
      a: { id: "a", kind: "send_sms", params: { body: "Your offer is ready" }, next: "b" },
      b: { kind: "wait", amount: 2, unit: "days", next: "c" },
      c: { id: "c", kind: "action", type: "create_task", params: { title: "Call {{full_name}}" }, next: null },
    });
    expect(nodes.a).toMatchObject({ id: "a", kind: "action", action: "send_sms", next: "b" });
    expect(nodes.b).toMatchObject({ id: "b", kind: "delay", mode: "duration", params: { amount: 2, unit: "days" }, next: "c" });
    expect(nodes.c).toMatchObject({ kind: "action", action: "create_task" });
    const graph = { triggers: [{ type: "application.stage_changed", filters: [], filterLogic: "all" as const }], startNodeId: "a", nodes };
    expect(validateGraph(graph as any, normalizeSettings({}), null, {})).toEqual([]);
  });

  it("leaves valid kinds alone", () => {
    const n = { id: "x", kind: "goto", target: "a" };
    expect(normalizeDraftNodes({ x: n }).x).toEqual(n);
  });

  it("normalizes the model's reply and sends a repair round with the problems", async () => {
    const create = vi.fn().mockResolvedValue(reply({ name: "Offer", graph: { triggers: [], startNodeId: "a", nodes: { a: { id: "a", kind: "send_sms", params: { body: "Ready" }, next: null } } } }));
    const out = await draftWorkflowFromText("text them", {}, create, { previous: "{\"name\":\"Offer\"}", issues: ["pick a stage"] });
    expect("error" in out).toBe(false);
    if (!("error" in out)) expect(out.graph.nodes.a).toMatchObject({ kind: "action", action: "send_sms" });
    const msgs = create.mock.calls[0][0].messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toEqual({ role: "assistant", content: "{\"name\":\"Offer\"}" });
    expect(msgs[3].content).toContain("pick a stage");
    expect(msgs[0].content).toContain("never in \"kind\"");
  });
});
