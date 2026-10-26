// BF_SERVER_v856_CRM_UNIFY - "Call: started an application, did not finish": one task per person, never after they
// submit (Sean Dwyer had six identical tasks from six restarted drafts, created after he had submitted).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn(async () => undefined) }));
vi.mock("../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));

import { startAbandonedApplicationWorker } from "../workers/abandonedApplicationWorker.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

async function tick(rows: unknown[]) {
  const query = vi.fn(answerBySql([[/abandon_task_created_at IS NULL/, { rows }]]));
  const worker = startAbandonedApplicationWorker({ query } as unknown as Pool);
  await h.tick;
  worker.stop();
  return query;
}

describe("abandoned application call task", () => {
  it("picks one draft per person and skips anyone who submitted or already has the task", async () => {
    const query = await tick([]);
    const sql = sqlText(callsMatching(query, /abandon_task_created_at IS NULL/)[0]![0]);
    expect(sql).toContain("SELECT DISTINCT ON (a.contact_id)");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM applications s WHERE s.contact_id = a.contact_id AND s.submitted_at IS NOT NULL)");
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM tasks t\s+WHERE t\.contact_id = a\.contact_id\s+AND t\.title = 'Call: started an application, did not finish'/);
  });
  it("covers the person's other drafts with the one task", async () => {
    const query = await tick([{ id: "app-1", contact_id: "c-1", silo: "BF", phone: "+14035550100" }]);
    expect(callsMatching(query, "INSERT INTO tasks")).toHaveLength(1);
    const siblings = callsMatching(query, /SET abandon_task_created_at = coalesce\(abandon_task_created_at, now\(\)\)/);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]![1]).toEqual(["c-1", "app-1"]);
  });
});
