import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

let token: string;
let appId: string;

describe("Documents", () => {
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
      .send({ name: "Doc App" });

    appId = appRes.body.data.id as string;
  });

  it("should upload document", async () => {
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("applicationId", appId)
      .field("category", "bank")
      .attach("file", Buffer.from("test"), "test.txt");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("should list documents", async () => {
    const res = await request(app)
      .get(`/api/applications/${appId}/documents`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
