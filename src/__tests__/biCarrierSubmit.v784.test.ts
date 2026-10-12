// BF_SERVER_v784_BI_CARRIER - carrier submit resolves BI's internal id through
// the read-only pgi-readiness lookup, then posts to BI's real route
// (/api/v1/bi/application/:id/submit-pgi) on the BI host every other BF->BI
// call uses, with a kind service / service bf-server token.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/SELECT bi_public_id FROM applications/i.test(sql)) return { rows: [{ bi_public_id: "PUB-123" }] };
      return { rows: [] };
    }),
  },
}));
vi.mock("../observability/logger.js", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

const SECRET = "test-secret-v784";
const calls: { url: string; init: any }[] = [];

beforeEach(() => {
  calls.length = 0;
  process.env.JWT_SECRET = SECRET;
  delete process.env.BI_SERVER_URL;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.includes("/api/v1/bi/maya/staff/pgi-readiness")) {
      return new Response(JSON.stringify({ ok: true, result: { applicationId: "bi-internal-42", stage: "submitted" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "submitted", externalId: "EXT-1" }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.BI_SERVER_URL; });

describe("submitBiToCarrier", () => {
  it("looks up the BI id, then posts to /api/v1/bi/application/<biId>/submit-pgi on the cse0 host", async () => {
    const { submitBiToCarrier } = await import("../services/biCarrierSubmit.js");
    const r = await submitBiToCarrier("app-1");
    expect(r).toEqual({ ok: true, externalId: "EXT-1", status: "submitted" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net/api/v1/bi/maya/staff/pgi-readiness");
    expect(JSON.parse(calls[0].init.body)).toEqual({ public_id: "PUB-123" });
    expect(calls[1].url).toBe("https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net/api/v1/bi/application/bi-internal-42/submit-pgi");
    expect(calls[1].init.method).toBe("POST");
    const token = String(calls[1].init.headers.authorization).replace(/^Bearer /, "");
    const claims: any = jwt.verify(token, SECRET, { algorithms: ["HS256"] });
    expect(claims.kind).toBe("service");
    expect(claims.service).toBe("bf-server");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("never posts when BI has no id for the public id", async () => {
    (globalThis.fetch as any).mockImplementationOnce(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    });
    const { submitBiToCarrier } = await import("../services/biCarrierSubmit.js");
    const r = await submitBiToCarrier("app-1");
    expect(r).toEqual({ ok: false, reason: "bi_id_not_found" });
    expect(calls.some((c) => c.url.includes("/submit-pgi"))).toBe(false);
  });

  it("no longer calls the dead bi-server.azurewebsites.net host, by default or when BI_SERVER_URL is set", async () => {
    const { submitBiToCarrier } = await import("../services/biCarrierSubmit.js");
    await submitBiToCarrier("app-1");
    process.env.BI_SERVER_URL = "https://bi.example.test/";
    await submitBiToCarrier("app-1");
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.url.startsWith("https://bi-server.azurewebsites.net")).toBe(false);
    expect(calls.slice(2).map((c) => c.url)).toEqual([
      "https://bi.example.test/api/v1/bi/maya/staff/pgi-readiness",
      "https://bi.example.test/api/v1/bi/application/bi-internal-42/submit-pgi",
    ]);
  });
});
