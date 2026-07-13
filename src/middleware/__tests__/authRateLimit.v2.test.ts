// BF_SERVER_AUTH_RATE_LIMIT_v2
import { describe, it, expect } from "vitest";
import { stripPort } from "../authRateLimit.js";

describe("stripPort", () => {
  it("strips the port Azure attaches to req.ip (this crashed OTP login in prod)", () => {
    // ValidationError: An invalid 'request.ip' (77.246.52.163:62553) was detected
    expect(stripPort("77.246.52.163:62553")).toBe("77.246.52.163");
  });

  it("leaves a bare IPv4 alone", () => {
    expect(stripPort("77.246.52.163")).toBe("77.246.52.163");
  });

  it("does NOT eat the last hextet of a bare IPv6", () => {
    // the old /:\d+$/ approach turned this into "2001:db8:85a3::8a2e:370" and the library
    // then rejected it with ERR_ERL_KEY_GEN_IPV6
    expect(stripPort("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(stripPort("::1")).toBe("::1");
  });

  it("handles bracketed IPv6 with a port", () => {
    expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripPort("[::1]")).toBe("::1");
  });

  it("tolerates empty input", () => {
    expect(stripPort("")).toBe("");
  });
});
