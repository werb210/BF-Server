// BF_SERVER_SERVICE_TOKEN_v1 + BF_SERVER_SERVICE_BRIDGE_v1
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireServiceToken, SERVICE_USER_ID } from "../middleware/serviceToken.js";
import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";
import serviceBridgeRoutes from "../routes/serviceBridge.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

function ctx(headers: Record<string, string>) {
  const req: any = { header: (k: string) => headers[k.toLowerCase()], body: {} };
  const res: any = {
    statusCode: 0, payload: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(p: any) { this.payload = p; return this; },
  };
  const next = vi.fn();
  return { req, res, next };
}

const TOKEN = "correct-horse-battery-staple";
afterEach(() => { delete process.env.BACKEND_SERVICE_TOKEN; });

describe("service token", () => {
  it("fails CLOSED when the secret is unset - never falls open", () => {
    delete process.env.BACKEND_SERVICE_TOKEN;
    const { req, res, next } = ctx({ "x-backend-token": "anything" });
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("rejects a wrong token", () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    const { req, res, next } = ctx({ "x-backend-token": "wrong" });
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing token", () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    const { req, res, next } = ctx({});
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts the right token and presents a service principal", () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    const { req, res, next } = ctx({ "x-backend-token": TOKEN, "x-silo": "BI" });
    requireServiceToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ silo: "BI", isService: true });
  });

  it("defaults to BF for an unrecognised silo header", () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    const { req, next } = ctx({ "x-backend-token": TOKEN, "x-silo": "NONSENSE" });
    requireServiceToken(req, {} as any, next);
    expect(req.user.silo).toBe("BF");
  });
});

describe("the bridge stays narrow", () => {
  const routes = () =>
    (serviceBridgeRoutes as any).stack
      .filter((l: any) => l.route)
      .flatMap((l: any) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
      .sort();
  const app = () => { const a = express(); a.use(express.json()); a.use("/api/service", serviceBridgeRoutes); return a; };

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[/INSERT INTO tasks/, { rows: [{ id: "t-1" }], rowCount: 1 }]]));
  });

  it("exposes only applicant messages, sms, mail, tasks and the staff picker", () => {
    expect(routes()).toEqual(["get /applicant-messages", "get /applicant-messages/unread", "get /bi-documents/:id/file", "get /staff", "post /applicant-messages", "post /applicant-messages/read", "post /mail", "post /sms", "post /tasks"]); // BF_SERVER_BLOCK_v610_BI_THREAD
  });

  it("guards every route with the service token", async () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    for (const r of routes()) {
      const [method, path] = r.split(" ") as [string, string];
      const res = await (request(app()) as any)[method](`/api/service${path.replace(":id", "x")}`).send({});
      expect(res.status, r).toBe(401);
      expect(res.body.error, r).toBe("invalid_backend_token");
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("writes tasks with the real column names and status enum", async () => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    const res = await request(app()).post("/api/service/tasks").set("x-backend-token", TOKEN).set("x-silo", "BI")
      .send({ title: "Call back", notes: "re: quote", type: "CALL", priority: "HIGH" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, task_id: "t-1", silo: "BI", assignee_user_id: SERVICE_USER_ID });
    const [ins] = callsMatching(queryMock, /INSERT INTO tasks/);
    expect(ins![0]).toMatch(/INSERT INTO tasks \(id, title, body, type, priority, status, silo, assignee_user_id, created_by/);
    expect(ins![0]).toContain("'NOT_STARTED'");
    expect(ins![1]).toEqual(["Call back", "re: quote", "CALL", "HIGH", "BI", SERVICE_USER_ID, SERVICE_USER_ID]);
  });

  it("is mounted at /api/service", () => {
    expect(API_ROUTE_MOUNTS.filter((m) => m.router === serviceBridgeRoutes).map((m) => m.path)).toEqual(["/service"]);
  });
});
