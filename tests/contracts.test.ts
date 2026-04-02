import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../src/contracts/api";

describe("API contract", () => {
  it("routes are defined", () => {
    expect(API_ROUTES.health).toBe("/api/v1/health");
  });
});
