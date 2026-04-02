import request from "supertest";

import { createServer } from "../src/server/createServer";
import { assertRequiredEnv } from "../src/server/runtimeGuards";

describe("System boot", () => {
  const originalPort = process.env.PORT;

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.PORT;
      return;
    }

    process.env.PORT = originalPort;
  });

  it("boots with zero external dependencies", async () => {
    const app = createServer();

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.server).toBe("ok");
    expect(["configured", "missing"]).toContain(res.body.data.twilio);
    expect(["ok", "degraded"]).toContain(res.body.data.db);
  });

  it("returns missing PORT when it is absent", () => {
    delete process.env.PORT;

    const result = assertRequiredEnv();

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["PORT"]);
  });

  it("returns ok when PORT is present", () => {
    process.env.PORT = String(Date.now());

    const result = assertRequiredEnv();

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
