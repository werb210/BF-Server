// BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const repo = vi.hoisted(() => ({ created: [] as any[], updated: [] as any[] }));
vi.mock("../repositories/lenderProducts.repo.js", async (orig) => ({
  ...(await orig<any>()),
  createLenderProduct: async (input: any) => { repo.created.push(input); return { id: "p1", name: input.name }; },
  fetchLenderProductById: async (id: string) => ({ id, name: "Old name", silo: "BF" }),
  updateLenderProduct: async (input: any) => { repo.updated.push(input); return { id: input.id, name: input.name }; },
}));

import router from "../routes/portalLenderProducts.js";

const app = express();
app.use(express.json());
app.use("/api/portal", router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status ?? 500).json({ code: err?.code, message: err?.message }));
const staff = "Bearer " + jwt.sign({ sub: "44444444-4444-4444-8444-444444444444", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

const post = (body: Record<string, unknown>) => request(app).post("/api/portal/lender-products").set("Authorization", staff).send({ lenderId: "l1", ...body });
const put = (body: Record<string, unknown>) => request(app).put("/api/portal/lender-products/p1").set("Authorization", staff).send(body);

beforeEach(() => { repo.created.length = 0; repo.updated.length = 0; });

describe("BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK", () => {
  it("POST handler accepts body.productName as fallback for body.name", async () => {
    const r = await post({ productName: "Working Capital LOC" });
    expect(r.status).toBe(201);
    expect(repo.created[0].name).toBe("Working Capital LOC");
    expect(r.body.productName).toBe("Working Capital LOC");
  });

  it("POST prefers body.name when both are sent", async () => {
    await post({ name: "Name wins", productName: "Fallback" });
    expect(repo.created[0].name).toBe("Name wins");
    await post({ name: "", productName: "Fallback" });
    expect(repo.created[1].name).toBe("Fallback");
  });

  it("PUT handler accepts body.productName as fallback for body.name", async () => {
    const r = await put({ productName: "Renamed LOC" });
    expect(r.status).toBe(200);
    expect(repo.updated[0]).toMatchObject({ id: "p1", name: "Renamed LOC" });
    await put({ name: "Name wins", productName: "Fallback" });
    expect(repo.updated[1].name).toBe("Name wins");
  });

  it("the validation error is still raised when neither field is present", async () => {
    for (const r of [await post({}), await post({ productName: "" }), await put({}), await put({ name: 7, productName: null })]) {
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: "validation_error", message: "name is required." });
    }
    expect(repo.created).toHaveLength(0);
    expect(repo.updated).toHaveLength(0);
  });
});
