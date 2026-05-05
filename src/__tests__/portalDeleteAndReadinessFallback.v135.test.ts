// BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1", () => {
  const portalSrc = readFileSync(
    join(__dirname, "..", "routes", "portal.ts"),
    "utf8"
  );
  const appsSrc = readFileSync(
    join(__dirname, "..", "modules", "applications", "applications.routes.ts"),
    "utf8"
  );

  it("anchor present in portal.ts", () => {
    expect(portalSrc).toContain(
      "BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1"
    );
  });

  it("anchor present in applications.routes.ts", () => {
    expect(appsSrc).toContain(
      "BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1"
    );
  });
});
