// BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10
// BF_SERVER_v784_CLIENT_OWNERSHIP - the guard moved out of src/routes/client/index.ts
// into src/auth/clientApplicationOwnership.ts and no longer lets token-less
// requests through; the mid-wizard (unclaimed) rule is unchanged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../auth/clientApplicationOwnership.ts", import.meta.url)),
  "utf-8",
);
const routerSrc = readFileSync(
  fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)),
  "utf-8",
);

describe("mid-wizard application ownership", () => {
  it("counts how many linked contacts actually have a phone", () => {
    expect(src).toContain("FROM app_phones WHERE p10 <> ''");
    expect(src).toContain("AS known");
  });

  it("only forbids when the application has a known owner that is not you", () => {
    // Unclaimed (known === 0) or owned (mine > 0) passes; everything else is the pivot case.
    expect(src).toContain("if (counts.mine > 0 || counts.known === 0) return { ok: true, principal };");
    expect(src).toContain('return { ok: false, status: 403, error: "forbidden" };');
  });

  it("the client router runs the shared guard", () => {
    expect(routerSrc).toContain("router.use(clientApplicationOwnershipGuard);");
  });

  it("no longer treats a missing or invalid token as capability access", () => {
    expect(src).toContain('if (!principal) return { ok: false, status: 401, error: "unauthorized" };');
    expect(routerSrc).not.toContain("treat as capability access, don't block");
  });
});
