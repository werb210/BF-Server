import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

let cookie: string[];

describe("Applications", () => {
  let app: Express;

  beforeAll(async () => {
    app = createServer();

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ otp: "123456" });

    cookie = res.headers["set-cookie"] as string[];
  });

  it("should create application", async () => {
    const res = await request(app)
      .post("/api/applications")
      .set("Cookie", cookie)
      .send({ name: "Test App" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBeDefined();
  });

  it("should fetch application", async () => {
    const create = await request(app)
      .post("/api/applications")
      .set("Cookie", cookie)
      .send({ name: "Fetch App" });

    const id = create.body.data.id as string;

    const res = await request(app)
      .get(`/api/applications/${id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
