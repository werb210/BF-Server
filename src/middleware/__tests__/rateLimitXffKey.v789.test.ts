// BF_SERVER_v789_XFF_KEY
import { describe, it, expect } from "vitest";
import { safeKeyGenerator } from "../rateLimit.js";

function req(xff: string | undefined, ip = "10.0.0.9") {
  return { headers: xff === undefined ? {} : { "x-forwarded-for": xff }, ip, socket: {} };
}

describe("safeKeyGenerator (middleware/rateLimit.ts)", () => {
  it("keys on the right-most (Azure-appended) entry", () => {
    expect(safeKeyGenerator(req("1.1.1.1, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("a spoofed left-most entry does not change the key", () => {
    const a = safeKeyGenerator(req("1.1.1.1, 203.0.113.7:51234"));
    const b = safeKeyGenerator(req("8.8.8.8, 203.0.113.7:40000"));
    const c = safeKeyGenerator(req("203.0.113.7"));
    expect(a).toBe("203.0.113.7");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("falls back to req.ip when there is no X-Forwarded-For", () => {
    expect(safeKeyGenerator(req(undefined, "::ffff:198.51.100.4"))).toBe("198.51.100.4");
    expect(safeKeyGenerator(req(undefined, "198.51.100.4:6553"))).toBe("198.51.100.4");
  });

  it("collapses IPv6 to a subnet so in-allocation rotation does not reset the key", () => {
    const a = safeKeyGenerator(req("1.1.1.1, 2001:db8:1:2::1"));
    const b = safeKeyGenerator(req("9.9.9.9, 2001:db8:1:2::ffff"));
    expect(a).toBe(b);
  });
});
