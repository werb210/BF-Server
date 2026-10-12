// BF_SERVER_SUGGESTED_NEXT_ACTIONS_v207
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlText } from "../../__tests__/helpers/answerBySql.js";

const { dbQueryMock, poolQueryMock } = vi.hoisted(() => ({ dbQueryMock: vi.fn(), poolQueryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, dbQuery: dbQueryMock, pool: { query: poolQueryMock } };
});

import * as nextActionsModule from "../nextActions.js";
import { buildNextActions } from "../nextActions.js";
import mayaStaff from "../../routes/mayaStaff.js";

type Row = { application_id: string; business_name: string | null; contact_id: string | null; action: string; reason: string; priority: number };
const row = (id: string, priority: number, action = "a" + priority): Row => ({
  application_id: id, business_name: "Biz " + id, contact_id: "c-" + id, action, reason: "because " + priority, priority,
});

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dbQueryMock.mockReset();
  dbQueryMock.mockResolvedValue({ rows: [] });
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  fetchSpy = vi.fn(async () => { throw new Error("no network in nextActions"); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function suggestionSql(): Promise<string> {
  await buildNextActions("BF");
  return sqlText(dbQueryMock.mock.calls[0][0]);
}
function branch(sql: string, actionLabel: string): string {
  // The UNION branch that produces the given action.
  return sql.split("UNION ALL").find((b) => b.includes(actionLabel)) ?? "";
}

describe("what it suggests", () => {
  it("never suggests anything about a closed file", async () => {
    const sql = await suggestionSql();
    expect(sql).toContain("!~* 'funded|declined|closed|rejected'");
    expect(dbQueryMock.mock.calls[0][1]).toEqual(["BF"]);
  });

  it("ranks a broken promise above a merely quiet file", async () => {
    const sql = await suggestionSql();
    expect(branch(sql, "documents were promised")).toContain("100 AS priority");
    expect(branch(sql, "the file has gone quiet")).toContain("50 AS priority");
    dbQueryMock.mockResolvedValue({ rows: [row("quiet", 50, "Follow up - the file has gone quiet"), row("promise", 100, "Call client - documents were promised")] });
    const out = await buildNextActions("BF");
    expect(out.map((a) => a.applicationId)).toEqual(["promise", "quiet"]);
  });

  it("only flags a promise the client has not since kept", async () => {
    expect(branch(await suggestionSql(), "documents were promised")).toMatch(/NOT EXISTS \([\s\S]{0,300}d\.created_at > cl\.created_at/);
  });

  it("ignores soft-deleted uploads when deciding a promise was kept", async () => {
    expect(branch(await suggestionSql(), "documents were promised")).toContain("d.deleted_at IS NULL");
  });

  it("only says every lender passed when at least one actually responded", async () => {
    const b = branch(await suggestionSql(), "every lender has passed");
    expect(b).toContain("COUNT(*) > 0");
    expect(b).toContain("COUNT(*) FILTER (WHERE r.outcome <> 'declined') = 0");
  });
});

describe("how it presents them", () => {
  it("shows one suggestion per application, the most urgent", async () => {
    dbQueryMock.mockResolvedValue({ rows: [row("app-1", 50), row("app-1", 100), row("app-1", 70), row("app-2", 90)] });
    const out = await buildNextActions("BF");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ applicationId: "app-1", businessName: "Biz app-1", contactId: "c-app-1", action: "a100", reason: "because 100", priority: 100 });
    expect(out[1].applicationId).toBe("app-2");
  });

  it("gives every suggestion a reason a person can act on", async () => {
    // A suggestion without a why is one staff will learn to scroll past.
    const sql = await suggestionSql();
    const actions = [...sql.matchAll(/'([^']+)' AS action/g)].map((m) => m[1]);
    const reasons = [...sql.matchAll(/AS reason/g)];
    expect(actions.length).toBeGreaterThan(0);
    expect(reasons.length).toBe(actions.length);
  });

  it("is rule-based, so every suggestion is explainable", async () => {
    dbQueryMock.mockResolvedValue({ rows: [row("app-1", 100)] });
    await buildNextActions("BF");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbQueryMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(nextActionsModule)).toEqual(["buildNextActions"]);
  });

  it("only suggests - it never writes", async () => {
    await buildNextActions("BF", 10);
    expect(dbQueryMock).toHaveBeenCalledTimes(1);
    expect(sqlText(dbQueryMock.mock.calls[0][0])).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
  });
});

describe("it cannot break the caller", () => {
  it("degrades to an empty list rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbQueryMock.mockRejectedValue(new Error("relation does not exist"));
    await expect(buildNextActions("BF")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nextActions"), expect.objectContaining({ message: "relation does not exist" }));
  });

  it("clamps the limit so a caller cannot ask for everything", async () => {
    dbQueryMock.mockResolvedValue({ rows: Array.from({ length: 150 }, (_, i) => row("app-" + String(i).padStart(3, "0"), 50)) });
    expect(await buildNextActions("BF", 1000)).toHaveLength(100);
    expect(await buildNextActions("BF", 0)).toHaveLength(1);
    expect(await buildNextActions("BF", -5)).toHaveLength(1);
    expect(await buildNextActions("BF", 7)).toHaveLength(7);
  });

  it("is a pure function of its query result", async () => {
    // With no database the query rejects, the catch fires, and the result must be an empty array.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    dbQueryMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(buildNextActions("BF")).resolves.toEqual([]);
  });
});

describe("route", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/maya", mayaStaff);

  it("requires the same service token as the rest of mayaStaff", async () => {
    const denied = await request(app).post("/api/maya/staff/next-actions").send({ silo: "BF" });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe("service_jwt_required");
    expect(dbQueryMock).not.toHaveBeenCalled();

    const staffJwt = jwt.sign({ sub: "u1", role: "Admin" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    expect((await request(app).post("/api/maya/staff/next-actions").set("Authorization", "Bearer " + staffJwt).send({})).status).toBe(401);

    dbQueryMock.mockResolvedValue({ rows: [row("app-1", 100)] });
    const svc = jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const ok = await request(app).post("/api/maya/staff/next-actions").set("Authorization", "Bearer " + svc).send({ silo: "BI", limit: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, silo: "BI" });
    expect(ok.body.actions).toHaveLength(1);
    expect(dbQueryMock.mock.calls[0][1]).toEqual(["BI"]);
  });
});
