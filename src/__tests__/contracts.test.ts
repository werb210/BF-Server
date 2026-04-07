import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../server/createServer";
import { endpoints } from "../contracts/endpoints";

describe("contracts", () => {
  const app = createServer();
  it("all endpoints exist", async () => {
    const contractEndpoints = Object.values(endpoints);

    for (const endpoint of contractEndpoints) {
      const response = await request(app).post(endpoint).send({});
      expect(response.status).not.toBe(404);
    }
  });
});
