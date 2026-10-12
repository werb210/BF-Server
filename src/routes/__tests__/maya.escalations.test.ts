import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return {
    ...actual,
    pool: {
      query: queryMock,
      connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
    },
  };
});
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));

// BF_SERVER_BLOCK_v574 - v317 put staff-only auth on this route (the agent calls it with a
// service JWT). The handler tests run as a signed staff user through the real gate; the gate
// itself is checked at the bottom of this file.
const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const tokenFor = (role: string) => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const NEW_ESCALATION = answerBySql([[/SELECT id FROM maya_escalations/, { rows: [] }], [/INSERT INTO maya_escalations/, { rows: [], rowCount: 1 }]]);

async function buildApp() {
  const { default: router } = await import("../maya.js");
  const app = express();
  app.use(express.json());
  app.use("/api/maya", router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
    res.status(status).json({
      status: "error",
      error: { code: err?.code || "internal", message: err?.message || "error" },
    });
  });
  return app;
}
async function post(body: Record<string, unknown>, role: string | null = "Staff") {
  const r = request(await buildApp()).post("/api/maya/escalations");
  return (role ? r.set("Authorization", `Bearer ${tokenFor(role)}`) : r).send(body);
}

describe("POST /api/maya/escalations", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("persists a new escalation and returns 201 with id", async () => {
    queryMock.mockImplementation(NEW_ESCALATION);
    const res = await post({ reason: "user_requested_human", sessionId: "sess-abc", surface: "client_app" });

    expect(res.status).toBe(201);
    expect(res.body?.data?.deduped).toBe(false);
    expect(res.body?.data?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    // v574: staff are also notified (MAYA_ESCALATION_NOTIFY), so count the insert, not every query.
    const [ins] = callsMatching(queryMock, /INSERT INTO maya_escalations/);
    expect(ins).toBeDefined();
    expect((ins![1] as unknown[]).slice(0, 5)).toEqual([res.body.data.id, "sess-abc", null, "user_requested_human", "client_app"]);
  });

  it("dedupes a repeat (sessionId + reason) within 60s and returns the existing id", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM maya_escalations/, { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] }],
    ]));
    const res = await post({ reason: "user_requested_human", sessionId: "sess-abc" });

    expect(res.status).toBe(200);
    expect(res.body?.data?.deduped).toBe(true);
    expect(res.body?.data?.id).toBe("11111111-1111-4111-8111-111111111111");
    const [dupe] = callsMatching(queryMock, /SELECT id FROM maya_escalations/);
    expect(dupe![1]).toEqual(["sess-abc", "user_requested_human"]);
    expect(callsMatching(queryMock, /INSERT INTO/)).toHaveLength(0); // dedupe SELECT only, no INSERT
  });

  it("ignores a non-uuid applicationId rather than rejecting", async () => {
    queryMock.mockImplementation(NEW_ESCALATION);
    const res = await post({
      reason: "low_confidence",
      sessionId: "sess-xyz",
      applicationId: "local-1768585153909", // not a uuid -> recorded as null
    });

    expect(res.status).toBe(201);
    const [insertCall] = callsMatching(queryMock, "INSERT INTO maya_escalations");
    expect(insertCall).toBeDefined();
    expect((insertCall![1] as unknown[])[2]).toBeNull(); // application_id arg -> null
  });
});

describe("POST /api/maya/escalations auth (v317)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(NEW_ESCALATION);
  });

  it("is staff-only", async () => {
    expect((await post({ reason: "x", sessionId: "s1" }, null)).status).toBe(401);
    expect((await post({ reason: "x", sessionId: "s2" }, "Ops")).status).toBe(403);
    expect((await post({ reason: "x", sessionId: "s2" }, "Lender")).status).toBe(403);
    expect(callsMatching(queryMock, /maya_escalations/)).toHaveLength(0);
    expect((await post({ reason: "x", sessionId: "s3" }, "Staff")).status).toBe(201);
    expect((await post({ reason: "x", sessionId: "s4" }, "Admin")).status).toBe(201);
  });
});
