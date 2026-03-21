import { describe, it, expect } from 'vitest';
const isCodespaces =
  process.env.CODESPACES === "true" ||
  Boolean(process.env.CODESPACE_NAME) ||
  Boolean(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN);

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireBaseUrl(): string | null {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    if (isCodespaces) {
      return null;
    }
    if (isCi) {
      throw new Error("BASE_URL is required for runtime health checks.");
    }
    return null;
  }
  if (isCodespaces && /localhost|127\.0\.0\.1/i.test(baseUrl)) {
    throw new Error("BASE_URL must not use localhost.");
  }
  if (!isCodespaces && /localhost|127\.0\.0\.1/i.test(baseUrl)) {
    return null;
  }
  return baseUrl;
}

describe("runtime health over forwarded BASE_URL", () => {
  const endpoints = ["/api/health", "/api/ready", "/api/_int/health"];

  it.each(endpoints)("responds with 200 for %s", async (path) => {
    const baseUrl = requireBaseUrl();
    if (!baseUrl) {
      return;
    }
    const url = new URL(path, baseUrl).toString();
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.status).not.toBe(302);
    const payload = await response.json();
    expect(payload).toEqual(expect.any(Object));
  });
});
