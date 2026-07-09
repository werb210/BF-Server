// BF_SERVER_MARKETING_INHERITS_STAFF_v1
import { describe, it, expect } from "vitest";
import { requireAuthorization } from "../auth.js";
import { ROLES } from "../../auth/roles.js";

function run(role: string, roles: string[]) {
  const req: any = { user: { role, userId: "u1" } };
  let forbidden = false;
  let nexted = false;
  const res: any = {
    status: (c: number) => {
      if (c === 403) forbidden = true;
      return res;
    },
    json: () => res,
  };

  requireAuthorization({ roles: roles as any })(req, res, () => {
    nexted = true;
  });

  return { forbidden, nexted };
}

describe("requireAuthorization marketing inherits staff (v1)", () => {
  it("Marketing passes a Staff-gated endpoint", () => {
    const r = run(ROLES.MARKETING, [ROLES.ADMIN, ROLES.STAFF]);
    expect(r.nexted).toBe(true);
    expect(r.forbidden).toBe(false);
  });

  it("Admin-only stays admin-only", () => {
    expect(run(ROLES.MARKETING, [ROLES.ADMIN]).forbidden).toBe(true);
    expect(run(ROLES.ADMIN, [ROLES.ADMIN]).nexted).toBe(true);
  });
});
