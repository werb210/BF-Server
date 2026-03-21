import { describe, it, expect } from 'vitest';
import type { Server } from "http";
import { resolveBaseUrl } from "./helpers/baseUrl";

describe("Codespaces runtime health", () => {
  const endpoints = [
    "/api/health",
    "/api/ready",
    "/api/_int/health",
    "/api/_int/build",
    "/api/_int/routes",
  ];
  let server: Server | null = null;
  let baseUrl: string | undefined;

  beforeAll(async () => {
    const { buildApp, registerApiRoutes } = await import("../app");
    const app = buildApp();
    registerApiRoutes(app);
    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server?.once("listening", resolve);
    });
    baseUrl = resolveBaseUrl(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  });

  it.each(endpoints)("returns 200 for %s", async (path) => {
    baseUrl = baseUrl ?? resolveBaseUrl(server ?? undefined);
    const url = new URL(path, baseUrl).toString();
    const response = await fetch(url, { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(302);
    const payload = await response.json();
    expect(payload).toEqual(expect.any(Object));
  });
});
