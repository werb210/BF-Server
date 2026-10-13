// BF_SERVER_v792_WORKFLOW_TEST_RUN - the enroll route returns the step log for a test run, keeps
// the old shape for a real enrollment, and the workflow may be Off. Database mocked by SQL content.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const RULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const graph = { triggers: [{ type: "manual", filters: [] }], startNodeId: "a", nodes: { a: { id: "a", kind: "action", action: "add_tag", params: { tag: "x" }, next: null } } };
const RULE_ROW = { id: RULE, name: "Off one", silo: "BF", enabled: false, graph, settings: null, goal: null, trigger_type: "manual", conditions: [] };
const STEPS = [
  { step_index: 0, node_id: "a", step_type: "add_tag", outcome: "dry_run", detail: "would run: add_tag" },
  { step_index: 1, node_id: "w", step_type: "delay", outcome: "dry_run", detail: "would wait 2 days" },
];

const q = vi.fn(async (sql: string, p: any[] = []) => {
  if (sql.includes("FROM automation_rules WHERE id = $1::uuid AND silo = $2")) return { rows: [RULE_ROW] };
  if (sql.includes("FROM automation_step_log WHERE enrollment_id = $1::uuid") && p[0] === "e-9") return { rows: STEPS };
  return { rows: [] };
});
vi.mock("../../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => q(sql, p as any[]) } }));
const enrollGraph = vi.fn(async (..._a: any[]) => "e-9");
vi.mock("../../modules/automation/graphEngine.js", () => ({ enrollGraph: (...a: any[]) => enrollGraph(...a) }));
vi.mock("../../modules/automation/automationEngine.js", () => ({
  defaultDeps: async () => ({ query: q, now: () => new Date() }),
  buildContext: async (_q: unknown, ev: any) => ({ silo: ev.silo, contact_id: ev.contactId, application_id: null }),
  runEnrollment: async () => "completed",
}));

import automations from "../automations.js";

function app(role: string) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: "u-1", userId: "u-1", role, silo: "BF" }; next(); });
  a.use("/api/automations", automations);
  return a;
}

describe("v792 test run response", () => {
  it("returns the steps for a test run, for Admin, Marketing and Staff, while the workflow is Off", async () => {
    for (const role of ["Admin", "Marketing", "Staff"]) {
      const r = await request(app(role)).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT, testMode: true });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ enrollmentId: "e-9", outcome: "completed", testMode: true, steps: STEPS });
    }
    expect(enrollGraph.mock.calls.at(-1)![1].settings.testMode).toBe(true);
  });

  it("a real enrollment keeps the old response", async () => {
    const r = await request(app("Staff")).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT });
    expect(r.body.data).toEqual({ enrollmentId: "e-9", outcome: "completed" });
  });
});
