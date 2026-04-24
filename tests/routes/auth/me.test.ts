import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import * as authRepo from "../../../src/modules/auth/auth.repo.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function bearerToken(): string {
  const token = jwt.sign(
    {
      userId: USER_ID,
      role: "Staff",
      phone: "+15555555555",
    },
    process.env.JWT_SECRET || "test-secret"
  );
  return `Bearer ${token}`;
}

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns name and email fields in body.user", async () => {
    vi.spyOn(authRepo, "findAuthUserById").mockResolvedValue({
      id: USER_ID,
      email: "todd@example.com",
      first_name: "Todd",
      last_name: "Howard",
      phoneNumber: "+15555555555",
      phoneVerified: true,
      role: "Staff",
      silo: "BF",
      lenderId: null,
      status: "active",
      active: true,
      isActive: true,
      disabled: false,
      lockedUntil: null,
      tokenVersion: 0,
    });

    const res = await request(createServer())
      .get("/api/auth/me")
      .set("authorization", bearerToken());

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: USER_ID,
      role: "Staff",
      silo: "BF",
      phone: "+15555555555",
      first_name: "Todd",
      last_name: "Howard",
      email: "todd@example.com",
    });
  });

  it("returns 200 with null identity fields when user lookup throws", async () => {
    vi.spyOn(authRepo, "findAuthUserById").mockRejectedValue(new Error("db down"));

    const res = await request(createServer())
      .get("/api/auth/me")
      .set("authorization", bearerToken());

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: USER_ID,
      role: "Staff",
      silo: "BF",
      phone: "+15555555555",
      first_name: null,
      last_name: null,
      email: null,
    });
  });
});
