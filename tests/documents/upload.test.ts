import { describe, it, expect } from 'vitest';
import request from "supertest";
import app from "../../src/index";

describe("Document Upload Contract", () => {
  it("should fail if missing required fields", async () => {
    const res = await request(app)
      .post("/api/documents/upload")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.missing).toContain("applicationId");
    expect(res.body.missing).toContain("category");
  });
});
