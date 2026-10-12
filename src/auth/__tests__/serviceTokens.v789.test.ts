// BF_SERVER_v789_SERVICE_TOKENS
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { signServiceToken, verifyServiceToken, tryVerifyServiceToken } from "../serviceTokens.js";

const saved = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = "main-secret-for-tests-0123456789";
  delete process.env.BI_SERVICE_JWT_SECRET;
  delete process.env.AGENT_SERVICE_JWT_SECRET;
});

afterEach(() => {
  process.env = { ...saved };
});

describe("signServiceToken", () => {
  it("adds iss bf-server, the audience and HS256", () => {
    const t = signServiceToken("bi-server");
    const header = jwt.decode(t, { complete: true })!.header;
    const claims = jwt.verify(t, "main-secret-for-tests-0123456789", { algorithms: ["HS256"] }) as any;
    expect(header.alg).toBe("HS256");
    expect(claims.iss).toBe("bf-server");
    expect(claims.aud).toBe("bi-server");
    expect(claims.kind).toBe("service");
  });

  it("signs BI-bound tokens with BI_SERVICE_JWT_SECRET when set", () => {
    process.env.BI_SERVICE_JWT_SECRET = "bi-only-secret-0123456789";
    const t = signServiceToken("bi-server");
    expect(() => jwt.verify(t, "main-secret-for-tests-0123456789", { algorithms: ["HS256"] })).toThrow();
    expect(() => jwt.verify(t, "bi-only-secret-0123456789", { algorithms: ["HS256"] })).not.toThrow();
  });

  it("keeps JWT_SECRET for other audiences even when BI secret is set", () => {
    process.env.BI_SERVICE_JWT_SECRET = "bi-only-secret-0123456789";
    const t = signServiceToken("agent", { source: "maya-service" });
    expect(() => jwt.verify(t, "main-secret-for-tests-0123456789", { algorithms: ["HS256"] })).not.toThrow();
  });
});

describe("verifyServiceToken", () => {
  const sign = (claims: object, secret: string, opts: jwt.SignOptions = {}) =>
    jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: "5m", ...opts });

  it("accepts a BI token signed with JWT_SECRET when no BI secret is set", () => {
    const t = sign({ kind: "service", source: "bi-server" }, "main-secret-for-tests-0123456789");
    expect(verifyServiceToken(t).sender).toBe("bi-server");
  });

  it("rejects a JWT_SECRET-signed BI token once BI_SERVICE_JWT_SECRET is set", () => {
    process.env.BI_SERVICE_JWT_SECRET = "bi-only-secret-0123456789";
    const bad = sign({ kind: "service", source: "bi-server" }, "main-secret-for-tests-0123456789");
    const good = sign({ kind: "service", source: "bi-server" }, "bi-only-secret-0123456789");
    expect(tryVerifyServiceToken(bad)).toBeNull();
    expect(verifyServiceToken(good).sender).toBe("bi-server");
  });

  it("rejects a JWT_SECRET-signed agent token once AGENT_SERVICE_JWT_SECRET is set", () => {
    process.env.AGENT_SERVICE_JWT_SECRET = "agent-only-secret-0123456789";
    const bad = sign({ kind: "service", source: "agent" }, "main-secret-for-tests-0123456789");
    const legacyBad = sign({ id: "agent-service", role: "Staff" }, "main-secret-for-tests-0123456789");
    const good = sign({ kind: "service", source: "agent" }, "agent-only-secret-0123456789");
    expect(tryVerifyServiceToken(bad)).toBeNull();
    expect(tryVerifyServiceToken(legacyBad)).toBeNull();
    expect(verifyServiceToken(good).sender).toBe("agent");
  });

  it("rejects a token whose aud is not bf-server; no aud passes", () => {
    const wrong = sign({ kind: "service", source: "agent" }, "main-secret-for-tests-0123456789", { audience: "bi-server" });
    const right = sign({ kind: "service", source: "agent" }, "main-secret-for-tests-0123456789", { audience: "bf-server" });
    const none = sign({ kind: "service", source: "agent" }, "main-secret-for-tests-0123456789");
    expect(tryVerifyServiceToken(wrong)).toBeNull();
    expect(tryVerifyServiceToken(right)).not.toBeNull();
    expect(tryVerifyServiceToken(none)).not.toBeNull();
  });

  it("rejects non-HS256 algorithms", () => {
    const t = jwt.sign({ kind: "service", source: "agent" }, "main-secret-for-tests-0123456789", { algorithm: "HS512" });
    expect(tryVerifyServiceToken(t)).toBeNull();
  });
});
