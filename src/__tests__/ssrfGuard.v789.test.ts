// BF_SERVER_v789_SSRF_GUARD - "train from URL" and the workflow webhook step resolve
// every hop and refuse internal addresses; redirects are followed by hand (max 3).
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../modules/ai/knowledge.service.js", () => ({ embedAndStore: vi.fn(async () => undefined), retrieveContext: vi.fn(async () => []) }));

import { assertPublicUrl, isBlockedAddress, ssrfSafeFetch, SsrfBlockedError } from "../security/ssrfGuard.js";
import { runGraphAction } from "../modules/automation/graphActions.js";

// Host -> addresses. Anything not listed fails to resolve.
const DNS: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "hooks.example": ["93.184.216.35", "2606:2800:220:1::1"],
  "internal.example": ["10.0.0.5"],
  "mixed.example": ["93.184.216.36", "127.0.0.1"],
  "metadata.example": ["169.254.169.254"],
  "cgnat.example": ["100.64.1.1"],
  "v6local.example": ["::1"],
  "v6ula.example": ["fd12:3456::1"],
  "v6mapped.example": ["::ffff:192.168.1.10"],
};

beforeEach(() => {
  vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string) => {
    const a = DNS[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("isBlockedAddress", () => {
  it.each([
    "10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "169.254.1.1",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd00::abcd", "fe80::1", "febf::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "::127.0.0.1", "ff02::1", "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:2800:220:1::1", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("refuses hosts that resolve to a blocked address (any of them)", async () => {
    for (const host of ["internal.example", "mixed.example", "metadata.example", "cgnat.example", "v6local.example", "v6ula.example", "v6mapped.example"]) {
      await expect(assertPublicUrl(new URL(`https://${host}/x`)), host).rejects.toMatchObject({ code: "address_not_public" });
    }
  });

  it("refuses IP literals without a lookup, and unresolvable names", async () => {
    await expect(assertPublicUrl(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({ code: "address_not_public" });
    await expect(assertPublicUrl(new URL("http://[::1]:8080/"))).rejects.toMatchObject({ code: "address_not_public" });
    await expect(assertPublicUrl(new URL("http://2130706433/"))).rejects.toMatchObject({ code: "address_not_public" });
    await expect(assertPublicUrl(new URL("https://nowhere.example/"))).rejects.toMatchObject({ code: "dns_failed" });
  });

  it("enforces https when asked, and allows a public host", async () => {
    await expect(assertPublicUrl(new URL("http://public.example/"), { httpsOnly: true })).rejects.toMatchObject({ code: "scheme_not_allowed" });
    await expect(assertPublicUrl(new URL("file:///etc/passwd"))).rejects.toMatchObject({ code: "scheme_not_allowed" });
    await expect(assertPublicUrl(new URL("https://public.example/"), { httpsOnly: true })).resolves.toBeUndefined();
    expect(dns.promises.lookup).toHaveBeenCalledWith("public.example", expect.objectContaining({ all: true }));
  });
});

function redirectTo(location: string, status = 302) {
  return { ok: false, status, headers: new Headers({ location }) };
}

describe("ssrfSafeFetch", () => {
  it("follows redirects by hand (redirect: manual) and re-checks every hop", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://public.example/a") return redirectTo("https://hooks.example/b", 308);
      if (url === "https://hooks.example/b") return redirectTo("/c", 307);
      return { ok: true, status: 200, headers: new Headers() };
    });
    const { response, url } = await ssrfSafeFetch("https://public.example/a", { method: "POST", body: "{}" }, { fetchImpl });
    expect(response.status).toBe(200);
    expect(url.toString()).toBe("https://hooks.example/c");
    expect(fetchImpl.mock.calls.map((c: any[]) => c[1].redirect)).toEqual(["manual", "manual", "manual"]);
    expect((fetchImpl.mock.calls[2] as any[])[1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("refuses a redirect to an internal address before requesting it", async () => {
    const fetchImpl = vi.fn(async () => redirectTo("http://169.254.169.254/latest/meta-data/"));
    await expect(ssrfSafeFetch("https://public.example/a", {}, { fetchImpl })).rejects.toMatchObject({ code: "address_not_public" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an https -> http downgrade when https only", async () => {
    const fetchImpl = vi.fn(async () => redirectTo("http://public.example/x"));
    await expect(ssrfSafeFetch("https://public.example/a", {}, { fetchImpl, httpsOnly: true })).rejects.toMatchObject({ code: "scheme_not_allowed" });
  });

  it("stops after 3 redirects", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => redirectTo(`https://public.example/r${++n}`));
    await expect(ssrfSafeFetch("https://public.example/start", {}, { fetchImpl })).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("turns a 303 into a GET without a body", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/a") ? redirectTo("/b", 303) : { ok: true, status: 200, headers: new Headers() }));
    await ssrfSafeFetch("https://public.example/a", { method: "POST", body: "x" }, { fetchImpl });
    const second = (fetchImpl.mock.calls[1] as any[])[1];
    expect(second.method).toBe("GET");
    expect(second.body).toBeUndefined();
  });
});

describe("workflow webhook step", () => {
  function harness() {
    const sql: Array<{ sql: string; p: any[] }> = [];
    const query = vi.fn(async (s: string, p: any[] = []) => { sql.push({ sql: s, p }); return { rows: [], rowCount: 1 }; });
    const httpFetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://hooks.example/redirect")) return { ok: false, status: 302, headers: new Headers({ location: "https://internal.example/steal" }) };
      return { ok: true, status: 200, headers: new Headers() };
    });
    const deps: any = { query, now: () => new Date(), sendSms: vi.fn(), notifyClient: vi.fn(), httpFetch };
    const e: any = { id: "enr-1", rule_id: "wf-7", silo: "BF", contact_id: "c-1", application_id: null, context: { first_name: "Pat", email: "pat@example.com" } };
    const run = (params: Record<string, unknown>) => runGraphAction(deps, e, { id: "n1", kind: "action", action: "webhook", params, next: null } as any);
    const audits = () => sql.filter((c) => /insert into audit_events/i.test(c.sql));
    return { run, httpFetch, audits };
  }

  it("sends to a public https host and audits workflow, host and field names (not values)", async () => {
    const h = harness();
    expect(await h.run({ url: "https://hooks.example/x", includeFields: ["first_name", "email"] })).toBe("webhook hooks.example 200");
    expect(h.httpFetch.mock.calls[0]![1]).toMatchObject({ redirect: "manual", method: "POST" });
    const rows = h.audits();
    expect(rows).toHaveLength(1);
    const p = rows[0]!.p;
    expect(p).toContain("automation_rule");
    expect(p).toContain("wf-7");
    expect(p).toContain("automation_webhook_send");
    const meta = JSON.parse(p[p.length - 1]);
    expect(meta).toMatchObject({ workflowId: "wf-7", host: "hooks.example", outcome: "sent", status: 200 });
    expect(meta.fields).toEqual(expect.arrayContaining(["first_name", "email"]));
    expect(JSON.stringify(meta)).not.toContain("pat@example.com");
    expect(JSON.stringify(meta)).not.toContain("Pat");
  });

  it("refuses internal targets, never calls them, and audits the refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const url of ["https://internal.example/x", "https://metadata.example/", "https://169.254.169.254/latest", "https://[::1]/", "https://v6mapped.example/"]) {
      const h = harness();
      await expect(h.run({ url }), url).rejects.toThrow(/non-public|not public|address/i);
      expect(h.httpFetch).not.toHaveBeenCalled();
      const meta = JSON.parse(h.audits()[0]!.p.at(-1));
      expect(meta.outcome).toBe("blocked:address_not_public");
    }
    warn.mockRestore();
  });

  it("refuses a redirect into the internal network", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness();
    await expect(h.run({ url: "https://hooks.example/redirect" })).rejects.toThrow();
    expect(h.httpFetch).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is https only", async () => {
    const h = harness();
    await expect(h.run({ url: "http://hooks.example/x" })).rejects.toThrow(/https/);
    expect(h.httpFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/ai-knowledge/url", () => {
  const SECRET = "test-secret-v789-ssrf";
  const ADMIN = "00000000-0000-0000-0000-0000000000ad";
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM users WHERE id = \$1/i.test(sql)) return { rows: [{ id: ADMIN, role: "Admin", silo: "BF", silos: ["BF"], is_active: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });
  async function app() {
    const router = (await import("../routes/settings.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/settings", router);
    return a;
  }
  const token = () => jwt.sign({ id: ADMIN, role: "Admin", capabilities: ["settings:read"] }, SECRET);

  it("refuses an internal URL with 400 and never fetches it", async () => {
    const f = vi.fn(async () => new Response("<html>secret</html>", { status: 200 }));
    vi.stubGlobal("fetch", f);
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://internal.example/", "http://127.0.0.1:5432/"]) {
      const res = await request(await app()).post("/api/settings/ai-knowledge/url").set("Authorization", `Bearer ${token()}`).send({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.error).toBe("url_not_allowed");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a public page that redirects inward", async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } }));
    vi.stubGlobal("fetch", f);
    const res = await request(await app()).post("/api/settings/ai-knowledge/url").set("Authorization", `Bearer ${token()}`).send({ url: "https://public.example/page" });
    expect(res.status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as any[])[1].redirect).toBe("manual");
  });

  it("ingests a public page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Hello world</body></html>", { status: 200 })));
    const res = await request(await app()).post("/api/settings/ai-knowledge/url").set("Authorization", `Bearer ${token()}`).send({ url: "https://public.example/page" });
    expect(res.status).toBe(200);
  });
});

void SsrfBlockedError;
