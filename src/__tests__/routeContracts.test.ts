import { describe, it, expect } from 'vitest';
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { ROLES } from "../auth/roles";

describe("portal route contracts", () => {
  let app: ReturnType<typeof buildAppWithApiRoutes>;
  let token: string;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-access-secret";
    app = buildAppWithApiRoutes();
    token = jwt.sign(
      { sub: "contract-user", role: ROLES.ADMIN, tokenVersion: 0 },
      process.env.JWT_SECRET ?? "test-access-secret",
      {
        expiresIn: "1h",
        issuer: "boreal-staff-server",
        audience: "boreal-staff-portal",
      }
    );
  });

  const authGet = (path: string) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);

  it("wraps portal responses in ok/data", async () => {
    const routes = [
      "/api/auth/me",
      "/api/dashboard",
      "/api/crm",
      "/api/communications",
      "/api/marketing",
      "/api/settings",
    ];

    for (const path of routes) {
      const res = await authGet(path);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body)).toBe(false);
      expect(Array.isArray(res.body.data)).toBe(false);
    }
  });

  it("keeps application lists stable when empty", async () => {
    const res = await authGet("/api/applications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it("returns empty items for list endpoints", async () => {
    const listRoutes = [
      "/api/crm/customers",
      "/api/crm/contacts",
      "/api/calendar",
      "/api/calendar/events",
      "/api/calendar/tasks",
      "/api/communications/messages",
      "/api/marketing/campaigns",
      "/api/lenders",
      "/api/tasks",
    ];

    for (const path of listRoutes) {
      const res = await authGet(path);
      expect(res.status).toBe(200);
      if (path.startsWith("/api/crm") || path.startsWith("/api/communications") || path.startsWith("/api/marketing") || path.startsWith("/api/tasks")) {
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toBeDefined();
      } else {
        expect(res.body).toEqual({ items: [] });
      }
    }
  });
});
