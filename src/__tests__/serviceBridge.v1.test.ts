// BF_SERVER_SERVICE_TOKEN_v1 + BF_SERVER_SERVICE_BRIDGE_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireServiceToken } from "../middleware/serviceToken.js";

const bridge = readFileSync(join(process.cwd(), "src", "routes", "serviceBridge.ts"), "utf-8");
const registry = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf-8");

function ctx(headers: Record<string, string>) {
  const req: any = { header: (k: string) => headers[k.toLowerCase()], body: {} };
  const res: any = {
    statusCode: 0, payload: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(p: any) { this.payload = p; return this; },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("service token", () => {
  it("fails CLOSED when the secret is unset — never falls open", () => {
    delete process.env.BACKEND_SERVICE_TOKEN;
    const { req, res, next } = ctx({ "x-backend-token": "anything" });
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("rejects a wrong token", () => {
    process.env.BACKEND_SERVICE_TOKEN = "correct-horse-battery-staple";
    const { req, res, next } = ctx({ "x-backend-token": "wrong" });
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing token", () => {
    process.env.BACKEND_SERVICE_TOKEN = "correct-horse-battery-staple";
    const { req, res, next } = ctx({});
    requireServiceToken(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts the right token and presents a service principal", () => {
    process.env.BACKEND_SERVICE_TOKEN = "correct-horse-battery-staple";
    const { req, res, next } = ctx({ "x-backend-token": "correct-horse-battery-staple", "x-silo": "BI" });
    requireServiceToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ silo: "BI", isService: true });
  });

  it("defaults to BF for an unrecognised silo header", () => {
    process.env.BACKEND_SERVICE_TOKEN = "correct-horse-battery-staple";
    const { req, next } = ctx({ "x-backend-token": "correct-horse-battery-staple", "x-silo": "NONSENSE" });
    requireServiceToken(req, {} as any, next);
    expect(req.user.silo).toBe("BF");
  });
});

describe("the bridge stays narrow", () => {
  it("exposes only sms, mail, tasks and the staff picker", () => {
    const routes = [...bridge.matchAll(/router\.(get|post)\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(routes.sort()).toEqual(["get /staff", "post /mail", "post /sms", "post /tasks"]);
  });
  it("guards every route with the service token", () => {
    expect(bridge).toContain("router.use(requireServiceToken)");
  });
  it("writes tasks with the real column names and status enum", () => {
    expect(bridge).toContain("INSERT INTO tasks (id, title, body, type, priority, status, silo, assignee_user_id, created_by");
    expect(bridge).toContain("'NOT_STARTED'");
  });
  it("is mounted at /api/service", () => {
    expect(registry).toContain('{ path: "/service", router: serviceBridgeRoutes }');
  });
});
