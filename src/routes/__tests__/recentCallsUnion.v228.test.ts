// BF_SERVER_RECENT_CALLS_UNION_v228
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

// The statement the Phone tab actually sends to Postgres.
async function recentCallsQuery(): Promise<string> {
  const app = mountRouter((await import("../voiceCalls.js")).default, "/api/voice");
  const res = await request(app).get("/api/voice/recent-calls").set("Authorization", `Bearer ${staffToken()}`);
  expect(res.status).toBe(200);
  const [call] = callsMatching(queryMock, /FROM call_logs cl/);
  expect(call).toBeDefined();
  return String(call[0]);
}

function branchColumnCounts(query: string): number[] {
  const inner = query.slice(query.indexOf("FROM ("));
  return inner.split(/\bUNION ALL\b/).flatMap((b) => {
    const m = b.match(/SELECT([\s\S]*?)\n\s*FROM\s/);
    if (!m) return [];
    const proj = m[1].replace(/--[^\n]*/g, "");
    let depth = 0, n = 1;
    for (const ch of proj) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) n++;
    }
    return [n];
  });
}

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("the union that emptied the Phone tab", () => {
  it("has more than one branch, which is what v203 missed", async () => {
    expect((await recentCallsQuery()).split("UNION ALL").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("projects the same number of columns in every branch", async () => {
    // Mismatched arity makes Postgres reject the whole statement. The handler
    // returns empty, and the portal renders "None yet." with no error shown.
    const counts = branchColumnCounts(await recentCallsQuery());
    expect(counts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(counts).size).toBe(1);
  });

  it("selects disposition in the outer list", async () => {
    expect(await recentCallsQuery()).toContain("contact_name, disposition");
  });

  it("projects a disposition from every branch, typed where it is null", async () => {
    const query = await recentCallsQuery();
    expect(query).toContain("cl.disposition,");
    expect(query.match(/NULL::text AS disposition/g)?.length).toBe(2);
  });

  it("keeps the inbound and seeded-owner branches that earlier fixes restored", async () => {
    const query = await recentCallsQuery();
    expect(query).toContain("cl.direction = 'inbound' AND cl.staff_user_id IS NULL");
    expect(query).toContain("00000000-0000-0000-0000-000000000099");
  });

  it("a failing statement is logged and the feed degrades to empty", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM call_logs cl/, new Error("each UNION query must have the same number of columns")]]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = mountRouter((await import("../voiceCalls.js")).default, "/api/voice");
    const res = await request(app).get("/api/voice/recent-calls").set("Authorization", `Bearer ${staffToken()}`);
    expect(res.body).toEqual({ ok: true, items: [] });
    expect(error).toHaveBeenCalledWith("[voice.recent-calls] query_failed", "each UNION query must have the same number of columns");
    error.mockRestore();
  });
});
