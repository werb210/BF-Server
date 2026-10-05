// BF_SERVER_INTAKE_ROUND_ROBIN_v749 / BF_SERVER_CLIENT_FAILURE_LOG_v749
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const q = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (sql: string, params?: unknown[]) => q(sql, params) } }));
import { intakeFilter, pickRoundRobin, bookableStaff, type Staff } from "../services/clientBooking.js";
import { isClientFailure, recordClientFailure, recentClientFailures, clearClientFailures, clientFailureLog } from "../middleware/clientFailureLog.js";

const mk = (id: string, email: string, mailbox: string, o365: boolean): Staff => ({ id, email, first_name: id, mailbox, o365 });
const todd = mk("t", "todd.w@boreal.financial", "todd.w@boreal.financial", true);
const andrew = mk("a", "andrew@boreal.financial", "andrew.p@boreal.financial", true);
const caden = mk("c", "caden@boreal.financial", "caden@boreal.financial", false);
const sam = mk("s", "sam@boreal.financial", "sam@boreal.financial", true);
const src = (p: string) => readFileSync(p, "utf8");

describe("intake team and round robin", () => {
  it("is Office 365 staff except Andrew, by login or mailbox; the env var overrides", () => {
    expect(intakeFilter([andrew, caden, sam, todd], undefined).map((s) => s.id)).toEqual(["s", "t"]);
    expect(intakeFilter([andrew, todd], "andrew.p@boreal.financial").map((s) => s.id)).toEqual(["t"]);
    expect(intakeFilter([andrew, todd], "todd.w@boreal.financial").map((s) => s.id)).toEqual(["a"]);
    expect(intakeFilter([andrew, todd], "").map((s) => s.id)).toEqual(["a", "t"]);
    expect(intakeFilter([andrew, caden], undefined).map((s) => s.id)).toEqual(["c"]);
  });
  it("never-booked first, then least recently booked; only free team members", () => {
    expect(pickRoundRobin(["s", "t"], new Map([["s", 100]]), [sam, todd])).toBe("t");
    expect(pickRoundRobin(["s", "t"], new Map([["s", 100], ["t", 200]]), [sam, todd])).toBe("s");
    expect(pickRoundRobin(["a"], new Map(), [sam, todd])).toBeNull();
  });
  it("books into the Office 365 mailbox, not the login email", async () => {
    q.mockImplementation(async (sql: string) => (/FROM users/.test(String(sql)) && /o365_user_email/.test(String(sql))
      ? { rows: [{ id: "a", email: "andrew@boreal.financial", first_name: "Andrew", mailbox: "andrew.p@boreal.financial", o365: true }] }
      : { rows: [] }));
    expect((await bookableStaff())[0]!.mailbox).toBe("andrew.p@boreal.financial");
    const s = src("src/services/clientBooking.ts");
    expect(s).toContain("/users/" + String.fromCharCode(36) + "{encodeURIComponent(staff.mailbox)}/events");
    expect(s).toContain("busyTimes(staff.map((s) => s.mailbox)");
    expect(s).toContain(": await intakeTeam();");
  });
});

describe("client failure log", () => {
  beforeEach(() => { clearClientFailures(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  it("counts 401, 403 and 5xx and keeps the newest 200", () => {
    expect([200, 400, 401, 403, 404, 500, 503].filter(isClientFailure)).toEqual([401, 403, 500, 503]);
    for (let i = 0; i < 205; i += 1) recordClientFailure({ at: String(i), method: "GET", path: "/x", status: 500, ms: 1, hadAuth: true, appVersion: null, instance: null, uptimeS: 1 });
    expect(recentClientFailures().length).toBe(200);
    expect(recentClientFailures()[0]!.at).toBe("204");
  });
  it("logs the path without the query string, nothing for a success", () => {
    const h: Record<string, () => void> = {};
    const req: any = { method: "GET", originalUrl: "/api/client/action-center?applicationId=abc&token=secret", headers: {} };
    clientFailureLog(req, { statusCode: 403, on: (e: string, f: () => void) => { h[e] = f; } } as any, () => undefined);
    h.finish!();
    clientFailureLog(req, { statusCode: 200, on: (e: string, f: () => void) => { h[e] = f; } } as any, () => undefined);
    h.finish!();
    expect(recentClientFailures().map((f) => f.path)).toEqual(["/api/client/action-center"]);
  });
  it("is mounted, admin-readable, and the SMS redirect falls back to www", () => {
    expect(src("src/app.ts")).toContain('app.use("/api/client", clientFailureLog);');
    expect(src("src/routes/admin.ts")).toContain('router.get("/client-failures"');
    expect(src("src/routes/smsRedirect.ts")).toContain('const fallbackUrl = "https://www.boreal.financial";');
  });
});
