import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

let cookie: string[];
let appId: string;

describe("Offers", () => {
  let app: Express;

  beforeAll(async () => {
    app = createServer();

    const auth = await request(app)
      .post("/api/auth/otp/verify")
      .send({ otp: "123456" });

    cookie = auth.headers["set-cookie"] as string[];

    const appRes = await request(app)
      .post("/api/applications")
      .set("Cookie", cookie)
      .send({ name: "Offer App" });

    appId = appRes.body.data.id as string;
  });

  it("should fetch offers", async () => {
    const res = await request(app)
      .get(`/api/offers?applicationId=${appId}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
