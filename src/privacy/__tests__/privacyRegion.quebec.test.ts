// BF_SERVER_v868_QUEBEC_CONSENT - GET /api/privacy/region: Quebec / other / unknown from the IP's region, a short
// in-memory cache, and the visitor's address never logged, stored or returned.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { IpIntel, IpIntelProvider } from "../../fraud/providers/lookups.js";
import { classifyRegion, createRegionResolver } from "../region.js";

const IP = "203.0.113.77";

function provider(answer: IpIntel | (() => Promise<IpIntel>), configured = true) {
  const lookup = vi.fn(async (_ip: string) => (typeof answer === "function" ? answer() : answer));
  const p: IpIntelProvider = { name: "fake", configured: () => configured, lookup };
  return { p, lookup };
}
const intel = (country: string | null, region: string | null): IpIntel => ({ ok: true, country, region, asn: null, asnOrg: null, vpn: null, proxy: null, hosting: null, tor: null });

// The suite resets modules after every test, so the route and the resolver it reads are loaded together here.
async function app(resolver: ReturnType<typeof createRegionResolver>) {
  const router = (await import("../../routes/privacy.js")).default;
  (await import("../../privacy/region.js")).setRegionResolverForTests(resolver);
  const a = express();
  a.use(express.json());
  a.use("/api/privacy", router);
  return a;
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
  }
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { logs.push(String(chunk)); return true; }) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("classifyRegion", () => {
  it("knows Quebec however ipinfo spells it", () => {
    expect(classifyRegion("CA", "Quebec")).toBe("QC");
    expect(classifyRegion("CA", "Québec")).toBe("QC");
    expect(classifyRegion("ca", "QC")).toBe("QC");
  });
  it("treats the rest of Canada and the US as other", () => {
    expect(classifyRegion("CA", "Alberta")).toBe("other");
    expect(classifyRegion("CA", "Ontario")).toBe("other");
    expect(classifyRegion("US", "Vermont")).toBe("other");
  });
  it("is unknown without a country, or a Canadian address without a province", () => {
    expect(classifyRegion(null, null)).toBe("unknown");
    expect(classifyRegion("CA", null)).toBe("unknown");
  });
});

describe("GET /api/privacy/region", () => {
  it("answers QC for a Quebec address, without logging or returning the address", async () => {
    const { p } = provider(intel("CA", "Quebec"));
    const res = await request(await app(createRegionResolver({ provider: p }))).get("/api/privacy/region").set("X-Forwarded-For", IP);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ region: "QC" });
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(JSON.stringify(res.body)).not.toContain(IP);
    expect(logs.join("\n")).not.toContain(IP);
  });

  it("answers other for the rest of Canada and the US", async () => {
    const { p } = provider(intel("US", "New York"));
    const res = await request(await app(createRegionResolver({ provider: p }))).get("/api/privacy/region").set("X-Forwarded-For", IP);
    expect(res.body).toEqual({ region: "other" });
  });

  it("answers unknown when ipinfo is not set up or the lookup fails", async () => {
    const off = provider(intel("CA", "Quebec"), false);
    expect((await request(await app(createRegionResolver({ provider: off.p }))).get("/api/privacy/region").set("X-Forwarded-For", IP)).body).toEqual({ region: "unknown" });
    expect(off.lookup).not.toHaveBeenCalled();

    const failing = provider({ ok: false, error: "timeout" });
    expect((await request(await app(createRegionResolver({ provider: failing.p }))).get("/api/privacy/region").set("X-Forwarded-For", IP)).body).toEqual({ region: "unknown" });

    const throwing = provider(async () => { throw new Error(`lookup for ${IP} failed`); });
    expect((await request(await app(createRegionResolver({ provider: throwing.p }))).get("/api/privacy/region").set("X-Forwarded-For", IP)).body).toEqual({ region: "unknown" });
    expect(logs.join("\n")).not.toContain(IP);
  });

  it("caches the answer briefly, keyed by a hash rather than the address", async () => {
    let t = 1_000_000;
    const { p, lookup } = provider(intel("CA", "Quebec"));
    const resolver = createRegionResolver({ provider: p, now: () => t, ttlMs: 60_000 });
    const a = await app(resolver);
    await request(a).get("/api/privacy/region").set("X-Forwarded-For", IP);
    await request(a).get("/api/privacy/region").set("X-Forwarded-For", IP);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(resolver.size()).toBe(1);
    t += 61_000; // past the TTL: looked up again
    await request(a).get("/api/privacy/region").set("X-Forwarded-For", IP);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache bounded", async () => {
    const { p } = provider(intel("CA", "Alberta"));
    const resolver = createRegionResolver({ provider: p, max: 3 });
    for (let i = 1; i <= 10; i++) await resolver.resolve(`198.51.100.${i}`);
    expect(resolver.size()).toBeLessThanOrEqual(3);
  });
});
