// BF_SERVER_v70_BLOCK_1_2
// The submit advances pipeline_state from draft: 'Received' when documents exist,
// 'Documents Required' when none do, and never clobbers a stage staff advanced.
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../src/__tests__/helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "../../src/__tests__/helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../src/db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../src/services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));

const SUBMIT_UPDATE = /SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$1::jsonb,\s+requested_amount = COALESCE\(\$2/;

async function submitUpdateSql(): Promise<{ sql: string; params: unknown[] }> {
  const res = await request(await buildV1App())
    .post(`/api/client/applications/${APP_ID}/submit`)
    .send({ app: { business: { companyName: "Acme" } } });
  expect(res.status).toBe(200);
  const calls = callsMatching(queryMock, SUBMIT_UPDATE);
  expect(calls).toHaveLength(1);
  return { sql: String(calls[0]![0]), params: calls[0]![1] as unknown[] };
}

describe("submit handler pipeline_state CASE", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
  });

  it("the submit update targets the submitted application and stamps submitted_at", async () => {
    const { sql, params } = await submitUpdateSql();
    expect(params[4]).toBe(APP_ID);
    expect(sql).toContain("submitted_at = NOW()");
  });

  it("writes pipeline_state via a CASE that checks for documents", async () => {
    const { sql } = await submitUpdateSql();
    expect(sql).toMatch(/pipeline_state = CASE[\s\S]+EXISTS \(\s*SELECT 1 FROM documents/);
    expect(sql).toMatch(/THEN 'Received'\s+ELSE 'Documents Required'/);
  });

  it("preserves an already-advanced pipeline_state (only updates from null/draft)", async () => {
    const { sql } = await submitUpdateSql();
    expect(sql).toMatch(/WHEN pipeline_state IS NULL OR pipeline_state IN \('draft','Draft',''\)/);
    expect(sql).toMatch(/ELSE pipeline_state\s+END/);
  });
});
