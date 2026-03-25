import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

let token: string;
let appId: string;

describe("Offers", () => {
  let app: Express;

  beforeAll(async () => {
    app = createServer();

    const auth = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+12345678901", code: "123456" });

    token = auth.body.token as string;

    const appRes = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Offer App" });

    appId = appRes.body.data.id as string;
  });

  it("should fetch offers", async () => {
    const res = await request(app)
      .get(`/api/offers?applicationId=${appId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
