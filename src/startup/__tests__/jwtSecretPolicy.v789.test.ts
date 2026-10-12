// BF_SERVER_v789_JWT_SECRET_POLICY
import { describe, it, expect, vi } from "vitest";
import { assertJwtSecretAtStartup, checkJwtSecret, JWT_SECRET_PLACEHOLDERS } from "../jwtSecretPolicy.js";

describe("checkJwtSecret", () => {
  it("rejects a missing or blank secret", () => {
    expect(checkJwtSecret(undefined).ok).toBe(false);
    expect(checkJwtSecret(null).ok).toBe(false);
    expect(checkJwtSecret("").ok).toBe(false);
    expect(checkJwtSecret("   ").ok).toBe(false);
  });

  it("rejects secrets shorter than 10 characters", () => {
    const r = checkJwtSecret("aB3$kq9Z1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/shorter than 10/);
  });

  it.each([
    "secret", "SECRET", "changeme", "ChangeMe", "change-me", "your-secret", "your_jwt_secret",
    "JWT_SECRET", "replace-me", "placeholder", "Default", "test", "dev-secret",
    "change-me-in-production",
  ])("rejects the placeholder %s (case-insensitive)", (value) => {
    const r = checkJwtSecret(value);
    expect(r.ok).toBe(false);
  });

  it("does not list the unit-test secrets as placeholders", () => {
    expect(JWT_SECRET_PLACEHOLDERS).not.toContain("test-jwt-secret");
    expect(JWT_SECRET_PLACEHOLDERS).not.toContain("test-secret");
    expect(checkJwtSecret("test-jwt-secret").ok).toBe(true);
  });

  it("accepts a 10-31 character secret with a warning", () => {
    const r = checkJwtSecret("test-jwt-secret");
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/at least 32/);
  });

  it("accepts a 32+ character secret without warnings", () => {
    const r = checkJwtSecret("x7Qp2LmN9vR4sT8wY1zA6bC3dE5fG0hJ");
    expect(r).toEqual({ ok: true, warnings: [] });
  });
});

describe("assertJwtSecretAtStartup", () => {
  it("throws (refuses to start) on a bad secret", () => {
    expect(() => assertJwtSecretAtStartup("changeme", () => {})).toThrow(/placeholder/);
    expect(() => assertJwtSecretAtStartup(undefined, () => {})).toThrow(/not set/);
  });

  it("warns but does not throw on a short-but-acceptable secret", () => {
    const warn = vi.fn();
    expect(() => assertJwtSecretAtStartup("test-jwt-secret", warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
