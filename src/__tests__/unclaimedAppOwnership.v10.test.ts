// BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)),
  "utf-8",
);

describe("mid-wizard application ownership", () => {
  it("counts how many linked contacts actually have a phone", () => {
    expect(src).toContain("FROM app_phones WHERE p10 <> ''");
    expect(src).toContain("AS known");
  });

  it("only forbids when the application has a known owner that is not you", () => {
    const middleware = src.slice(
      src.indexOf("BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10"),
      src.indexOf('router.use("/", continuationRouter)'),
    );
    expect(middleware).toContain("if (total > 0 && known > 0 && mine === 0) {");
    // The old predicate rejected every unclaimed application.
    expect(middleware).not.toContain("if (total > 0 && mine === 0) {");
  });

  it("still forbids a genuine pivot to someone else's application", () => {
    // known > 0 && mine === 0 is precisely the pivot case, and it still 403s.
    const guard = src.slice(src.indexOf("const known ="), src.indexOf("return next();", src.indexOf("const known =")));
    expect(guard).toContain('res.status(403).json({ error: "forbidden" })');
  });

  it("leaves the capability fallbacks untouched", () => {
    // No token, no app id, unverifiable token: all still fall through.
    expect(src).toContain('if (!aid) return next();');
    expect(src).toContain("return next(); // invalid/expired token -> treat as capability access, don't block");
    expect(src).toContain("if (!phone10) return next();");
  });
});
