// BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10
// BF_SERVER_CLIENT_OWNERSHIP_v1 - the rule moved into auth/clientApplicationOwnership.ts
// (clientOwnershipOf) and the client router's guard no longer lets a request
// without a token, or with an unverifiable token, through to an existing
// application. Behaviour is covered in routes/client/__tests__/clientOwnership.audit.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)),
  "utf-8",
);
const rule = readFileSync(
  fileURLToPath(new URL("../auth/clientApplicationOwnership.ts", import.meta.url)),
  "utf-8",
);

describe("mid-wizard application ownership", () => {
  it("counts how many linked contacts actually have a phone", () => {
    expect(rule).toContain("FROM app_phones WHERE p10 <> ''");
    expect(rule).toContain("AS known");
  });

  it("an application nobody has claimed yet is claimable by the signed-in client", () => {
    expect(rule).toContain('if (known === 0 && phone10.length === 10) return "owner";');
  });

  it("still forbids a genuine pivot to someone else's application", () => {
    expect(rule).toContain('return "not_owner";');
    expect(src).toContain('if (own === "not_owner") {');
    expect(src).toContain('res.status(403).json({ error: "forbidden" })');
  });

  it("no longer treats a missing or unverifiable token as capability access", () => {
    expect(src).not.toContain("return next(); // invalid/expired token -> treat as capability access, don't block");
    expect(src).toContain('res.status(401).json({ error: "auth_required"');
    // Ids that are not applications (continuation / submit tokens) still fall through.
    expect(src).toContain("if (Number(exists.rows?.[0]?.n ?? 0) === 0) return next();");
  });
});
