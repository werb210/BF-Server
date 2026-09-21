// BF_SERVER_WATCH_CALLBACK_FROM_OTP_v370 / BF_SERVER_WATCH_FACE_v370 / BF_SERVER_WATCH_CALL_ERRORS_v370
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");
const auth = read("src/modules/auth/auth.service.ts");
const migration = read("migrations/2026_09_21_v370_watch_callback_backfill.sql");
const calls = read("src/watch/callRoutes.ts");
const snap = read("src/watch/snapshotRoutes.ts");
const data = read("src/watch/dataRoutes.ts");
const registry = read("src/routes/routeRegistry.ts");

describe("Watch calls have a callback number", () => {
  it("staff OTP sign-in records the verified phone as the callback number", () => {
    expect(auth).toMatch(/update users set verified_callback_number = \$1, callback_verified_at = now\(\) where id = \$2/);
    expect(auth.indexOf("verified_callback_number")).toBeGreaterThan(auth.indexOf("update users set phone_verified"));
  });
  it("existing staff are backfilled from their verified login phone, idempotently", () => {
    expect(migration).toContain("SET verified_callback_number = phone_number");
    expect(migration).toContain("WHERE verified_callback_number IS NULL");
    expect(migration).toContain("COALESCE(phone_verified, false) = true");
  });
});

describe("Watch call failures say what went wrong", () => {
  it("distinguishes a missing caller ID from a provider rejection", () => {
    expect(calls).toContain('"provider_not_configured"');
    expect(calls).toContain("TWILIO_CALLER_ID");
    expect(calls).toContain("Calling provider rejected the call");
    expect(calls).toContain("error_code=$2");
  });
});

describe("Watch face data", () => {
  it("the Watch can fetch its own face data with a Watch token", () => {
    expect(data).toContain('router.get("/face"');
    expect(data).toContain("buildWatchSnapshot(String(req.watch.staffUserId))");
  });
  it("staff /watch/snapshot is no longer shadowed by watchAuth", () => {
    expect(snap).not.toContain("router.use(requireAuth)");
    expect(registry.indexOf("watchRoutes.use(watchSnapshotRoutes)")).toBeLessThan(registry.indexOf("watchRoutes.use(watchDataRoutes)"));
  });
});
