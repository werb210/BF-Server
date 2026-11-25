// BF_SERVER_CRM_SAVED_VIEWS_v1
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock } }));
vi.mock("../../middleware/silo.js", () => ({ resolveSiloFromRequest: (req: any) => req.headers["x-silo"] ?? "BF" }));

import router, { cleanFilters } from "../viewRoutes.js";

const app = (role = "staff") => {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { userId: "11111111-1111-4111-8111-111111111111", role }; next(); });
  a.use("/", router);
  return a;
};
afterEach(() => queryMock.mockReset());

describe("CRM saved views", () => {
  it("keeps only the list filters", () => {
    expect(cleanFilters({ tag: "broker", ownerId: "u1", evil: "x", q: "  " })).toEqual({ tag: "broker", ownerId: "u1" });
  });

  it("lists the business's views", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "v1", name: "Call list", filters: { tag: "call" } }] });
    const r = await request(app()).get("/").set("X-Silo", "KS");
    expect(r.body.views).toHaveLength(1);
    expect(queryMock.mock.calls[0]![1]).toEqual(["KS"]);
  });

  it("needs a name, and saves under the business", async () => {
    expect((await request(app()).post("/").send({ filters: {} })).status).toBe(400);
    queryMock.mockResolvedValue({ rows: [{ id: "v2", name: "Brokerages", filters: { tag: "brokerage" } }] });
    const r = await request(app()).post("/").set("X-Silo", "KS").send({ name: "Brokerages", filters: { tag: "brokerage" } });
    expect(r.status).toBe(201);
    expect(queryMock.mock.calls[0]![1].slice(0, 3)).toEqual(["KS", "Brokerages", JSON.stringify({ tag: "brokerage" })]);
  });

  it("only removes a view for an Admin or its maker", async () => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    const r = await request(app()).delete("/22222222-2222-4222-8222-222222222222");
    expect(r.status).toBe(404);
    expect(queryMock.mock.calls[0]![1][2]).toBe(false);
  });
});
