import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { endpoints } from "../src/contracts/endpoints";

describe("contracts", () => {
  it("all endpoints exist", async () => {
    const contractEndpoints = Object.values(endpoints);

    for (const endpoint of contractEndpoints) {
      const response = await request(app).post(endpoint).send({});
      expect(response.status).not.toBe(404);
    }
  });
});
