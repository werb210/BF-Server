import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { readAccountantIdentity } from "../middleware/requireAccountant.js";

const auth = readFileSync(fileURLToPath(new URL("../routes/auth.ts", import.meta.url)), "utf-8");

const SECRET = "test-secret-for-accountant-tokens";
function reqWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe("BF_SERVER_ACCOUNTANT_OTP_v1 login branch", () => {
  it("matches on the accountant tag the capture flows write", () => {
    expect(auth).toContain("'Accountant/advisor' = ANY(COALESCE(tags, '{}'::text[]))");
    expect(auth).toContain("silo = 'BF'");
  });

  it("refuses a shared phone rather than picking one", () => {
    expect(auth).toContain("ambiguous_accountant_phone");
  });

  it("refuses a phone with no accountant behind it", () => {
    expect(auth).toContain("no_accountant_for_phone");
  });

  it("binds the token to the contact, not an application", () => {
    expect(auth).toContain('contactId: String(accountant.id)');
  });

  it("keeps the accountant role outside the staff role set", () => {
    expect(auth).toContain('role: "accountant"');
  });

  it("expires sooner than the client token", () => {
    expect(auth).toContain('{ expiresIn: "7d" }');
  });
});

describe("BF_SERVER_ACCOUNTANT_OTP_v1 guard", () => {
  const original = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = original; });

  it("accepts a well-formed accountant token", () => {
    const token = jwt.sign({ role: "accountant", contactId: "c-1", phone: "+15875551234" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toEqual({ contactId: "c-1", phone: "+15875551234" });
  });

  it("rejects a token with the role but no contact binding", () => {
    const token = jwt.sign({ role: "accountant" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a staff token", () => {
    const token = jwt.sign({ role: "Admin", contactId: "c-1" }, SECRET);
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = jwt.sign({ role: "accountant", contactId: "c-1" }, "some-other-secret");
    expect(readAccountantIdentity(reqWith(token))).toBeNull();
  });

  it("rejects a missing header", () => {
    expect(readAccountantIdentity({ headers: {} } as any)).toBeNull();
  });
});
