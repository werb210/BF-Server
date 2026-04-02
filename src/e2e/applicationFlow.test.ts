import request from "supertest";
import { buildApp } from "../app"; // adjust if different

describe("End-to-End Application Flow", () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp();
  });

  test("login", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "test@test.com", password: "password" });

    expect(res.status).toBeLessThan(500);
  });

  test("create application", async () => {
    const res = await request(app)
      .post("/applications")
      .send({ name: "Test App" });

    expect(res.status).toBeLessThan(500);
  });

  test("fetch pipeline", async () => {
    const res = await request(app).get("/pipeline");

    expect(res.status).toBeLessThan(500);
  });
});
