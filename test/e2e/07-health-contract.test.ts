import request from "supertest";

import { createServer } from "../../src/server/createServer";

describe("Health contract", () => {
  it("returns exactly { success: true }", async () => {
    const app = createServer();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(Object.keys(res.body)).toEqual(["success"]);
  });
});
