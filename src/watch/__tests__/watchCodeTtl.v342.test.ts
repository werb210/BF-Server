// BF_SERVER_WATCH_CODE_TTL_v342
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routes = readFileSync(resolve(__dirname, "..", "authRoutes.ts"), "utf-8");

describe("an enrollment code outlives its delivery window", () => {
  it("lasts a day, not five minutes", () => {
    // The durable WCSession application context can be delivered hours after the
    // phone sends it - that is the point of it - so a five-minute code arrived
    // dead and the Watch could never link on that path.
    expect(routes).toContain("const ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60_000;");
    expect(routes).toContain("new Date(Date.now() + ENROLLMENT_CODE_TTL_MS)");
    expect(routes).not.toContain("Date.now() + 5 * 60_000");
  });

  it("is still single-use, which is what actually bounds the risk", () => {
    expect(routes).toContain("SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()");
  });

  it("is still stored only as a hash", () => {
    expect(routes).toContain("hashWatchSecret(code)");
    expect(routes).not.toContain("VALUES($1,$2,$3)`,\n    [staffUserId, code,");
  });

  it("still needs a staff token to mint and refuses a client one", () => {
    expect(routes).toContain('String(req.user?.role || "").toLowerCase() === "client"');
    expect(routes).toContain('router.post("/enrollment", auth, limiter,');
  });

  it("still rate limits the link route", () => {
    expect(routes).toContain('router.post("/link", limiter,');
    expect(routes).toContain("windowMs: 60_000, limit: 10");
  });

  it("still tells an expired code apart from an invalid one", () => {
    expect(routes).toContain('"expired_code"');
    expect(routes).toContain('"unauthenticated"');
  });
});
