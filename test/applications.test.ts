import request from "supertest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

let token: string;

describe("Applications", () => {
  let app: Express;

  beforeAll(async () => {
    app = createServer();

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+12345678901", code: "123456" });

    token = res.body.token as string;
  });

  it("should create application", async () => {
    const res = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test App" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBeDefined();
  });

  it("should fetch application", async () => {
    const create = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fetch App" });

    const id = create.body.data.id as string;

    const res = await request(app)
      .get(`/api/applications/${id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
