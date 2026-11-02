// BF_SERVER_v870_CRM_DATA_MODEL - extra pipelines and custom stages beside Boreal's locked lending pipeline (ported from
// KS-server #47, no plan limit).
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { PIPELINE_STATES } from "../../modules/applications/pipelineState.js";
import { canAddPipeline, lendingPipeline, moveApplication, normalizeLendingProbabilities, validatePipeline, weighted, writeStages } from "../pipelines.js";

describe("limits", () => {
  it("no plan gate: only a safety limit of 50 extra pipelines per silo", () => {
    expect(canAddPipeline(0)).toBe(true);
    expect(canAddPipeline(49)).toBe(true);
    expect(canAddPipeline(50)).toBe(false);
  });
});

describe("the lending pipeline", () => {
  it("keeps every system stage, locked, in order", async () => {
    const p = await lendingPipeline({ query: vi.fn(answerBySql([])) });
    expect(p).toMatchObject({ id: "lending", system: true });
    expect(p.stages.map((s) => s.name)).toEqual(PIPELINE_STATES);
    expect(p.stages.every((s) => s.locked)).toBe(true);
    // Boreal funds after acceptance: Funded is the won stage.
    expect(p.stages.find((s) => s.name === "Funded")).toMatchObject({ outcome: "won", probability: 100 });
    expect(p.stages.find((s) => s.name === "Accepted")).toMatchObject({ outcome: "open", probability: 90 });
    expect(p.stages.find((s) => s.name === "Rejected")).toMatchObject({ outcome: "lost" });
  });

  it("only its probabilities can be set (0 to 100)", () => {
    expect(normalizeLendingProbabilities({ Received: 15, Offer: 900, Bogus: 5 })).toMatchObject({ Received: 15, Offer: 75 });
    expect(Object.keys(normalizeLendingProbabilities({}))).toEqual(PIPELINE_STATES);
  });
});

describe("extra pipelines", () => {
  it("checks the name and stages", () => {
    const bad = validatePipeline({ name: "Lending", stages: [{ name: "A", probability: 120 }, { name: "a" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["name", "stages.0.probability", "stages.1.name"]);
    expect(validatePipeline({ name: "Renewals", stages: [{ name: "Won", outcome: "won" }, { name: "Lost", outcome: "lost" }] }).ok).toBe(false);
    const ok = validatePipeline({ name: "Renewals", stages: [{ name: "Due soon", color: "#0F766E", probability: 20 }, { name: "Renewed", outcome: "won", probability: 100 }] });
    expect(ok).toEqual({ ok: true, name: "Renewals", stages: [
      { id: null, name: "Due soon", color: "#0f766e", probability: 20, outcome: "open" },
      { id: null, name: "Renewed", color: "#1d4ed8", probability: 100, outcome: "won" },
    ] });
  });

  it("never removes a stage that still has deals", async () => {
    const q = vi.fn(answerBySql([[/FROM pipeline_stages s WHERE s.pipeline_id = \$1::uuid/, { rows: [{ id: "11111111-1111-4111-8111-111111111111", name: "Due soon", deals: 3 }] }]]));
    const r = await writeStages({ query: q }, "p1", [{ id: null, name: "New", color: "#1d4ed8", probability: 0, outcome: "open" }]);
    expect(r).toEqual({ ok: false, error: `Move the deals out of "Due soon" (3) before removing that stage.` });
    expect(callsMatching(q, /UPDATE pipeline_stages|INSERT INTO pipeline_stages/)).toHaveLength(0);
  });

  it("a deal never moves to another silo's pipeline", async () => {
    const PID = "22222222-2222-4222-8222-222222222222";
    const q = vi.fn(answerBySql([
      [/FROM applications a LEFT JOIN pipeline_stages/, { rows: [{ id: "a1", pipeline_id: null, pipeline_state: "Offer", silo: "BF", stage_name: null }] }],
      [/SELECT \* FROM pipelines/, { rows: [{ id: PID, name: "BI renewals", silo: "BI", position: 1, archived_at: null }] }],
      [/FROM pipeline_stages s WHERE s.pipeline_id = ANY/, { rows: [{ id: "33333333-3333-4333-8333-333333333333", pipeline_id: PID, name: "New", position: 0, color: "#1d4ed8", probability: 0, outcome: "open" }] }],
    ]));
    expect(await moveApplication({ query: q }, "a1", PID, null, null)).toMatchObject({ ok: false, error: "wrong_silo" });
    expect(callsMatching(q, /UPDATE applications/)).toHaveLength(0);
  });

  it("moving back to lending keeps the deal's lending stage", async () => {
    const q = vi.fn(answerBySql([[/FROM applications a LEFT JOIN pipeline_stages/, { rows: [{ id: "a1", pipeline_id: "22222222-2222-4222-8222-222222222222", pipeline_state: "Offer", stage_name: "Due soon" }] }]]));
    expect(await moveApplication({ query: q }, "a1", "lending", null, null)).toEqual({ ok: true, pipeline_id: "lending", stage: "Offer" });
    expect(String(callsMatching(q, /UPDATE applications/)[0]![0])).toContain("pipeline_id = NULL");
    const [, p] = callsMatching(q, /INSERT INTO pipeline_moves/)[0]!;
    expect(p).toEqual(["a1", "22222222-2222-4222-8222-222222222222", "Due soon", "Offer", null]);
  });

  it("weights amounts by probability", () => {
    expect(weighted(100000, 25)).toBe(25000);
  });
});
