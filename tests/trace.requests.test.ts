import request from "supertest";
import { app } from "../src";
import * as logger from "../src/observability/logger";

describe("request traceability", () => {
  it("includes a request id for health checks", async () => {
    const res = await request(app || require("../src/app").default).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("returns a request id for unmatched routes", async () => {
    const res = await request(app || require("../src/app").default).get("/this/route/does/not/exist");
    expect(res.status).toBe(404);
    expect(res.body.requestId).toBeTruthy();
  });

  it("logs request start and route resolution for auth routes", async () => {
    const logSpy = vi.spyOn(logger, "logInfo");
    const res = await request(app || require("../src/app").default).post("/api/auth/otp/start").send({});
    expect(res.status).toBe(204);

    const events = logSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain("request_started");
    expect(events).toContain("route_resolved");
    logSpy.mockRestore();
  });

  it("lists all registered routes", async () => {
    const res = await request(app || require("../src/app").default).get("/api/_int/routes");
    expect(res.status).toBe(200);
    const inventory = res.body.routes as Array<{
      routerBase: string;
      routes: Array<{ method: string; path: string }>;
    }>;
    const paths = inventory.flatMap((group) =>
      group.routes.map((route) => route.path)
    );
    expect(paths).toContain("/api/auth/otp/start");
    expect(paths).toContain("/health");
  });
});
