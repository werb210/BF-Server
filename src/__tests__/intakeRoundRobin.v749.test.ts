// BF_SERVER_BOOKING_MAILBOX_v749 / BF_SERVER_CLIENT_FAILURE_LOG_v749
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const q = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (sql: string, params?: unknown[]) => q(sql, params) } }));
import { intakeTeam, mailboxOf, bookableStaff, type Staff } from "../services/clientBooking.js";
import { isClientFailure, recordClientFailure, recentClientFailures, clearClientFailures, clientFailureLog } from "../middleware/clientFailureLog.js";

const todd: Staff = { id: "t", email: "todd.w@boreal.financial", first_name: "Todd", signed_in: true, mailbox: "todd.w@boreal.financial" };
const andrew: Staff = { id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" };
const src = (p: string) => readFileSync(p, "utf8");

describe("booking mailbox (BF_SERVER_BOOKING_MAILBOX_v749)", () => {
  afterEach(() => { delete process.env.BOOKING_INTAKE_EXCLUDE; });
  it("Andrew is out of the intake team whether he logs in as andrew@ or andrew.p@", () => {
    expect(intakeTeam([todd, andrew]).map((s) => s.id)).toEqual(["t"]);
    expect(intakeTeam([todd, { ...andrew, email: "andrew.p@boreal.financial" }]).map((s) => s.id)).toEqual(["t"]);
    process.env.BOOKING_INTAKE_EXCLUDE = "andrew.p@boreal.financial";
    expect(intakeTeam([todd, andrew]).map((s) => s.id)).toEqual(["t"]);
  });
  it("the calendar is the Office 365 mailbox, falling back to the login email", async () => {
    expect(mailboxOf(andrew)).toBe("andrew.p@boreal.financial");
    expect(mailboxOf({ id: "x", email: "Sam@boreal.financial", first_name: null })).toBe("sam@boreal.financial");
    q.mockImplementation(async (sql: string) => (/FROM users/.test(String(sql)) && /o365_user_email/.test(String(sql))
      ? { rows: [{ id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" }] }
      : { rows: [] }));
    expect(mailboxOf((await bookableStaff())[0]!)).toBe("andrew.p@boreal.financial");
    const s = src("src/services/clientBooking.ts");
    expect(s).toContain("/users/" + String.fromCharCode(36) + "{encodeURIComponent(mailboxOf(staff))}/events");
    expect(s).toContain("busyTimes(staff.map(mailboxOf)");
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
