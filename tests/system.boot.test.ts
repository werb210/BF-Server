import request from "supertest";

import { createServer } from "../src/server/createServer";
import { assertRequiredEnv } from "../src/server/runtimeGuards";
import { applyEnv, captureOriginalEnv, restoreEnv, unsetEnv } from "../test/utils/testEnv";

describe("System boot", () => {
  let originalEnv = captureOriginalEnv();

  beforeEach(() => {
    originalEnv = captureOriginalEnv();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("boots with zero external dependencies", async () => {
    const app = createServer();

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns missing PORT when it is absent", () => {
    unsetEnv(["PORT"]);

    const result = assertRequiredEnv();

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["PORT"]);
  });

  it("returns ok when PORT is present", () => {
    applyEnv({ PORT: String(Date.now()) });

    const result = assertRequiredEnv();

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
