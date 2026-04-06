import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app";

describe("server smoke routes", () => {
  it("GET /health returns 200", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.text).toBe("healthy");
  });

  it("GET /api/_int/health returns 200", async () => {
    const res = await request(app).get("/api/_int/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
