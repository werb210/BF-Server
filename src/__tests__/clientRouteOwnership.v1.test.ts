// BF_SERVER_CLIENT_ROUTE_GUARD_v1
// src/routes/client/index.ts carries a guard that stops a signed-in client
// reading an application that is not theirs. Routers mounted THERE inherit it.
// Routers mounted in routeRegistry.ts do not, and nothing says so at the point
// of mounting. Two routes were mounted that way and both leaked: /client/voice
// minted a spoofable Twilio identity from a query parameter, and
// /client/documents-needed returned any application's document checklist.
//
// This test fails when a new /client/* router is mounted outside the guard
// without either checking ownership itself or being listed below with a reason.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const registry = readFileSync(resolve(__dirname, "..", "routes", "routeRegistry.ts"), "utf-8");

// Routers that legitimately need no ownership check. Adding an entry here is a
// deliberate act and must carry a reason.
const EXEMPT: Record<string, string> = {
  "/client":
    "This IS the guarded router (src/routes/client/index.ts). The guard lives inside it.",
  "/client/issues":
    "Write-only bug report. applicationId is optional metadata, nothing is read back.",
};

function mountedClientRouters(): Array<{ path: string; router: string }> {
  const out: Array<{ path: string; router: string }> = [];
  const re = /\{\s*path:\s*"(\/client[^"]*)"\s*,\s*router:\s*(\w+)\s*\}/g;
  for (const m of registry.matchAll(re)) out.push({ path: m[1], router: m[2] });
  return out;
}

function sourceFor(routerIdent: string): string {
  const imp = new RegExp(`import\\s+${routerIdent}\\s+from\\s+"\\.\\/([^"]+)"`).exec(registry);
  if (!imp) throw new Error(`cannot resolve the import for ${routerIdent}`);
  const rel = imp[1].replace(/\.js$/, ".ts");
  return readFileSync(resolve(__dirname, "..", "routes", rel), "utf-8");
}

describe("BF_SERVER_CLIENT_ROUTE_GUARD_v1", () => {
  const mounts = mountedClientRouters();

  it("finds the client routers mounted outside the guarded router", () => {
    // If this drops to zero the regex has stopped matching and every
    // assertion below would pass vacuously.
    expect(mounts.length).toBeGreaterThan(2);
  });

  it.each(mounts)("$path either checks ownership or is exempt with a reason", ({ path, router }) => {
    if (EXEMPT[path]) {
      expect(EXEMPT[path].length).toBeGreaterThan(20);
      return;
    }
    const src = sourceFor(router);
    expect(
      src.includes("callerOwnsApplication"),
      `${path} is mounted in routeRegistry.ts, so it does NOT inherit the guard in ` +
      `src/routes/client/index.ts. Either call callerOwnsApplication() from ` +
      `src/auth/clientApplicationOwnership.ts, mount it inside client/index.ts, ` +
      `or add it to EXEMPT in this test with a reason.`,
    ).toBe(true);
  });

  it.each(mounts.filter((m) => !EXEMPT[m.path]))("$path fails closed", ({ path, router }) => {
    const src = sourceFor(router);
    // A check that logs and continues is not a check.
    expect(src, `${path} must refuse, not warn`).toMatch(/status\(40[34]\)/);
    const check = src.indexOf("callerOwnsApplication(");
    const refuse = src.search(/status\(40[34]\)/);
    expect(refuse, `${path} must refuse after the ownership check`).toBeGreaterThan(check);
  });

  it("the shared predicate covers partners and guarantors, not just the applicant", () => {
    const pred = readFileSync(
      resolve(__dirname, "..", "auth", "clientApplicationOwnership.ts"), "utf-8");
    // A joint file's partner has a different phone from applications.contact_id.
    // Losing the UNION would 403 every partner on every application.
    expect(pred).toContain("application_contacts");
    expect(pred).toContain("UNION");
    // No token, bad token, wrong phone, or a failed query must all deny.
    expect(pred).toMatch(/return false/);
    expect(pred).not.toMatch(/return true;\s*\/\/ *fail open/i);
  });
});
