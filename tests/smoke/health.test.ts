import { describe, it, expect } from 'vitest';
import { get } from "../_utils/http";
import { startSmokeServer } from "./smokeServer";

describe("health smoke", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const server = await startSmokeServer();
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  test("GET /_int/health", async () => {
    const response = await get<{ status: string }>("/_int/health");
    expect(response.status).toBe("ok");
  });

  test("GET /_int/runtime", async () => {
    const response = await get<{
      build: { version: string | null; commit: string | null };
      cors: { enabled: boolean | null };
      db: { connected: boolean | null };
      warnings: string[];
    }>("/_int/runtime");

    expect(response.build).toBeTruthy();
    expect(response.build).toHaveProperty("version");
    expect(response.build).toHaveProperty("commit");
    expect(response.cors).toBeTruthy();
    expect(response.cors).toHaveProperty("enabled");
    expect(response.db).toBeTruthy();
    expect(response.db).toHaveProperty("connected");
    expect(Array.isArray(response.warnings)).toBe(true);
  });
});
