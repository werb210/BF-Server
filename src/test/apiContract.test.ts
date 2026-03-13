import request from "supertest";
import { buildAppWithApiRoutes } from "../app";

describe("API contract", () => {
  const app = buildAppWithApiRoutes();

  it("server exposes expected routes", async () => {
    const res = await request(app).get("/api/_int/routes");

    expect(res.status).toBe(200);

    const routes = res.body.routes as string[];

    expect(routes).toContain("/api/continuation/:token");
    expect(routes).toContain("/api/call/status");
    expect(routes).toContain("/api/support/escalations");
  });
});
