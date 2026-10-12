// BF_SERVER_LENDER_SELF_v1 - lender self-service API: role-gated, scoped to the token's lender, mounted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: async () => ({ smsSent: 0, notifsCreated: 0, recipientCount: 0 }) }));
import lenderSelf from "../routes/lenderSelf.js";
import { API_ROUTE_MOUNTS, ROUTES } from "../routes/routeRegistry.js";
import { ROLES } from "../auth/roles.js";

const LENDER_ID = "21212121-2121-4121-8121-212121212121";
const sign = (claims: Record<string, unknown>) => "Bearer " + jwt.sign(claims, process.env.JWT_SECRET as string);
const lender = sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID });

const app = express();
app.use(express.json());
app.use("/api/lender", lenderSelf);

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM lenders\s+WHERE id::text = \$1/, { rows: [{ id: LENDER_ID }] }],
    [/UPDATE lenders/, { rows: [{ id: LENDER_ID }] }],
    [/INSERT INTO lender_products/, { rows: [{ id: "p-new", name: "LOC" }] }],
    [/UPDATE lender_products/, { rows: [{ id: "p-1", name: "LOC" }] }],
  ]));
});

const product = { name: "Line", category: "LOC", country: "CA", rate_kind: "apr", rate_type: "FIXED" };

describe("lender self-service API", () => {
  it("is role-gated", async () => {
    const staff = await request(app).get("/api/lender/me").set("Authorization", sign({ sub: LENDER_ID, role: "Staff", lenderId: LENDER_ID }));
    expect(staff.status).toBe(403);
    expect(staff.body.message).toBe("lender_role_required");
    const unbound = await request(app).get("/api/lender/me").set("Authorization", sign({ sub: "lender:x", role: "Lender" }));
    expect(unbound.status).toBe(403);
    expect(unbound.body.message).toBe("no_lender_binding");
    expect((await request(app).get("/api/lender/me")).status).toBe(401);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("is lender-scoped, from lenderId or lender_id in the token", async () => {
    await request(app).get("/api/lender/products").set("Authorization", lender);
    await request(app).get("/api/lender/products").set("Authorization", sign({ sub: "lender:y", role: "Lender", lender_id: "snake-lender" }));
    const reads = callsMatching(h.query, /FROM lender_products/);
    expect(String(reads[0][0])).toContain("lender_id::text = $1");
    expect(reads.map((c) => (c[1] as unknown[])[0])).toEqual([LENDER_ID, "snake-lender"]);
  });

  it("is mounted at /api/lender with lender-only role requirements", () => {
    expect(API_ROUTE_MOUNTS.find((m) => m.path === "/lender")?.router).toBe(lenderSelf);
    const find = (method: string, path: string) => ROUTES.find((r) => r.method === method && r.path === path);
    expect(find("POST", "/api/lender/products")?.roles).toEqual([ROLES.LENDER]);
    expect(find("PATCH", "/api/lender/products/:id")?.roles).toEqual([ROLES.LENDER]);
  });

  it("exposes profile and product write endpoints", async () => {
    expect((await request(app).get("/api/lender/me").set("Authorization", lender)).status).toBe(200);
    expect((await request(app).patch("/api/lender/me").set("Authorization", lender).send({ website: "https://x.test" })).status).toBe(200);
    expect((await request(app).get("/api/lender/products").set("Authorization", lender)).status).toBe(200);
    expect((await request(app).post("/api/lender/products").set("Authorization", lender).send(product)).status).toBe(201);
    expect((await request(app).patch("/api/lender/products/p-1").set("Authorization", lender).send(product)).status).toBe(200);
  });

  it("validates product CHECK constraint values before writes", async () => {
    for (const [field, value] of [["country", "MX"], ["rate_kind", "weekly"], ["rate_type", "floating"], ["category", "CARD"]] as const) {
      const r = await request(app).post("/api/lender/products").set("Authorization", lender).send({ ...product, [field]: value });
      expect(r.status, field).toBe(400);
    }
    expect(callsMatching(h.query, /INSERT INTO lender_products/)).toHaveLength(0);
    for (const country of ["CA", "US", "BOTH"]) {
      expect((await request(app).post("/api/lender/products").set("Authorization", lender).send({ ...product, country })).status).toBe(201);
    }
    await request(app).patch("/api/lender/products/p-1").set("Authorization", lender).send({ ...product, category: "term" });
    const [sql, params] = callsMatching(h.query, /UPDATE lender_products/)[0] as [string, unknown[]];
    expect(sql).toContain("type = $4"); // type mirrors the category
    expect(params.slice(0, 4)).toEqual([LENDER_ID, "p-1", "Line", "TERM"]);
  });
});
