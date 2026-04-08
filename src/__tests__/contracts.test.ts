import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("contracts", () => {
  const app = createApp();
  it("all endpoints exist", async () => {
    const contractEndpoints = ["/api/v1/lead", "/api/v1/call/start", "/api/v1/call/status", "/api/v1/message"];

    for (const endpoint of contractEndpoints) {
      const response = await request(app).post(endpoint).send({});
      expect(response.status).not.toBe(404);
    }
  });
});
