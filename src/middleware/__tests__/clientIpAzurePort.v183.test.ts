// BF_SERVER_AZURE_XFF_PORT_v183
import { describe, expect, it } from "vitest";
import { clientIpFromRequest } from "../clientIp.js";

const req = (headers: Record<string, string> = {}, ip?: string) =>
  ({ headers, ip }) as never;

describe("clientIpFromRequest", () => {
  it("strips the port Azure appends to x-forwarded-for", () => {
    // The exact value from the production log that threw.
    expect(clientIpFromRequest(req({ "x-forwarded-for": "199.119.235.200:52995" })))
      .toBe("199.119.235.200");
  });

  it("keys the same client identically across connections", () => {
    const a = clientIpFromRequest(req({ "x-forwarded-for": "199.119.235.200:52995" }));
    const b = clientIpFromRequest(req({ "x-forwarded-for": "199.119.235.200:61204" }));
    expect(a).toBe(b);
  });

  it("takes the client entry from a multi-hop chain", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.9:443, 10.0.0.1" })))
      .toBe("203.0.113.9");
  });

  it("does not mangle a bare IPv6 address", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("unwraps a bracketed IPv6 address with a port", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "[2001:db8::1]:52995" })))
      .toBe("2001:db8::1");
  });

  it("unmaps an IPv4-in-IPv6 address", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "::ffff:203.0.113.9" })))
      .toBe("203.0.113.9");
  });

  it("falls back to req.ip when the header is absent", () => {
    expect(clientIpFromRequest(req({}, "203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIpFromRequest(req({}))).toBe("unknown");
  });
});

describe("every rate limiter carries a key generator", () => {
  it("leaves none on the library default, which rejects an ip:port", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== "__tests__") walk(full); }
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk("src");

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      let from = 0;
      for (;;) {
        const at = src.indexOf("rateLimit({", from);
        if (at === -1) break;
        let depth = 0;
        let end = at + "rateLimit(".length;
        for (let i = end; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (!src.slice(at, end).includes("keyGenerator")) offenders.push(file);
        from = at + 1;
      }
    }
    expect(offenders).toEqual([]);
  });
});
