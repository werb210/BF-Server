// BF_SERVER_FUNNEL_STEP_KEY_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App } from "../../__tests__/helpers/v1AppsHarness.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

async function patchedMetadata(body: Record<string, unknown>) {
  queryMock.mockReset();
  queryMock.mockImplementation(
    answerBySql([PARAM_GUARD_RULE, [/select id, name, pipeline_state/, { rows: [{ id: APP_ID, name: "Draft", metadata: {} }] }]]),
  );
  const res = await request(await buildV1App()).patch(`/api/client/applications/${APP_ID}`).send(body);
  expect(res.status).toBe(200);
  return (callsMatching(queryMock, /update applications\s+set name = \$2/)[0]![1] as unknown[])[3] as Record<string, unknown>;
}

async function funnelSql(): Promise<string> {
  queryMock.mockReset();
  queryMock.mockImplementation(
    answerBySql([[/WITH stepped AS/, { rows: [{ started: "10", step2: "6", step3: "4", step4: "3", step5: "2", step6: "1", submitted: "1" }] }]]),
  );
  const app = express();
  app.use("/api/dashboard", (await import("../dashboard.js")).default);
  const res = await request(app).get("/api/dashboard/funnel").set("Authorization", bearer("Admin"));
  expect(res.status).toBe(200);
  expect(res.body.data.steps[0]).toMatchObject({ label: "Begin application", count: 10 });
  expect(res.body.data.submitted).toBe(1);
  const calls = callsMatching(queryMock, /WITH stepped AS/);
  expect(calls).toHaveLength(1);
  return String(calls[0]![0]);
}

describe("funnel reads the step key the server actually writes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("the server normalises both spellings to camelCase", async () => {
    // This is why snake_case was always empty.
    const camel = await patchedMetadata({ currentStep: 3 });
    expect(camel.currentStep).toBe(3);
    const snake = await patchedMetadata({ current_step: 4 });
    expect(snake.currentStep).toBe(4);
    expect(snake).not.toHaveProperty("current_step");
    const both = await patchedMetadata({ currentStep: 2, current_step: 5 });
    expect(both.currentStep).toBe(2);
  });

  it("the funnel prefers metadata->>'currentStep'", async () => {
    const sql = await funnelSql();
    expect(sql).toContain("NULLIF(metadata->>'currentStep','')::int");
    expect(sql.indexOf("NULLIF(metadata->>'currentStep','')::int")).toBeLessThan(sql.indexOf("NULLIF(metadata->>'current_step','')::int"));
  });

  it("keeps snake_case and the column as fallbacks", async () => {
    const sql = await funnelSql();
    expect(sql).toContain("NULLIF(metadata->>'current_step','')::int");
    expect(sql).toContain("current_step, 1) AS step");
  });

  it("applies the same key to the empty-shell exclusion", async () => {
    // If the exclusion used a different key from the projection, real
    // applicants would be dropped from the funnel as if they never started.
    const sql = await funnelSql();
    const exclusion = sql.slice(sql.indexOf("AND NOT (submitted_at IS NULL"));
    expect(exclusion).toContain("NULLIF(metadata->>'currentStep','')::int");
    expect(sql.split("NULLIF(metadata->>'currentStep','')::int").length - 1).toBeGreaterThanOrEqual(2);
  });
});
