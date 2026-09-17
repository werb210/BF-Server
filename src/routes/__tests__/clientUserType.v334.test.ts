// BF_SERVER_CLIENT_USERTYPE_v334
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const auth = readFileSync(resolve(__dirname, "..", "auth.ts"), "utf-8");

describe("the client app gets a client token, whoever the phone belongs to", () => {
  it("reads userType from the verify body, like the lender, referrer and accountant portals", () => {
    expect(auth).toContain('const wantsClient = String((req.body ?? {}).userType ?? "") === "client";');
  });

  it("stops the staff branch claiming a login that asked to be a client", () => {
    expect(auth).toContain("if (isActiveStaff && user && !wantsClient) {");
  });

  it("still mints a staff token for the portal, which sends no userType", () => {
    // The portal's login is unchanged: no userType, active staff row, staff token.
    const staffBranch = auth.slice(auth.indexOf("if (isActiveStaff && user && !wantsClient) {"));
    expect(staffBranch.slice(0, 900)).toContain("capabilities: fetchCapabilitiesForRole(role),");
  });

  it("the client token still carries role client, which no staff check accepts", () => {
    expect(auth).toContain('role: "client",');
    expect(auth).toContain("isClient: true,");
  });

  it("says which reason produced a client token", () => {
    expect(auth).toContain('console.log("[otp_verify] client_fallthrough", { phone, requestedClient: wantsClient, isActiveStaff });');
  });

  it("does not weaken the lender, referrer or accountant branches, which run first", () => {
    const clientCheck = auth.indexOf("const wantsClient =");
    for (const earlier of ["const wantsLender =", "const wantsReferrer =", "const wantsAccountant ="]) {
      expect(auth.indexOf(earlier)).toBeGreaterThan(0);
      expect(auth.indexOf(earlier)).toBeLessThan(clientCheck);
    }
  });
});
