// BF_SERVER_BLOCK_v473_SIGNING_OWNER_v1
import { describe, it, expect, beforeAll, vi } from "vitest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeSigningOwnerGuard } from "../routes/client/signingOwner.js";

const SECRET = "test-secret-v473-signing";
beforeAll(() => { process.env.JWT_SECRET = SECRET; });

function run(guard: any, headers: Record<string, string>, applicationId = "app-1") {
  const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  const next = vi.fn();
  return guard({ query: { applicationId }, headers }, res, next).then(() => ({ res, next }));
}
const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${jwt.sign(claims, SECRET)}` });

describe("v473 signing-session owner guard", () => {
  it("refuses a request with no login", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 1 }] })), {});
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses a token with no phone claim", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 1 }] })), bearer({ userId: "u1" }));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses a signed-in client whose phone is not on the application", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 0 }] })), bearer({ phone: "+1 (403) 555-0100" }));
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
  it("lets the applicant through and matches on the last ten digits", async () => {
    let params: unknown[] = [];
    const { next } = await run(makeSigningOwnerGuard(async (_t, p) => { params = p ?? []; return { rows: [{ mine: 1 }] }; }), bearer({ phone: "+1 (403) 555-0100" }));
    expect(next).toHaveBeenCalledOnce();
    expect(params).toEqual(["app-1", "4035550100"]);
  });
  it("fails closed when the ownership query errors", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => { throw new Error("db down"); }), bearer({ phone: "4035550100" }));
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
  it("is mounted on /signing-session", () => {
    const src = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
    expect(src).toMatch(/"\/signing-session",\s*\n\s*\/\/[^\n]*\n\s*makeSigningOwnerGuard\(/);
  });
});

describe("v473 Maya product ranges", () => {
  const staff = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
  it("returns ranges computed over every matching product", () => {
    expect(staff).toContain("BF_SERVER_BLOCK_v473_MAYA_RANGES_v1");
    expect(staff).toContain("GROUP BY 1, 2");
    expect(staff).toContain("return res.json({ ok: true, products, ranges, totalMatching, summary });");
  });
  it("never mixes rate kinds and tells Maya to quote from ranges", () => {
    expect(staff).toContain("lower(coalesce(lp.rate_kind, '')) AS rate_kind");
    expect(staff).toContain("Quote amount and rate limits from ranges");
  });
});
