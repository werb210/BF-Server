// BF_SERVER_LANDING_BASE_HOST_v14
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../services/landingPage.service.ts", import.meta.url)),
  "utf-8",
);

describe("landing page base host", () => {
  it("defaults to the host that actually serves /e/:slug", () => {
    expect(src).toContain('process.env.LANDING_BASE_URL || "https://www.boreal.financial"');
    // The apex returns Not Found for /e/* - it is not the Static Web App.
    expect(src).not.toContain('|| "https://boreal.financial"');
  });

  it("still allows an override once the apex is fixed", () => {
    expect(src).toContain("process.env.LANDING_BASE_URL");
  });

  it("keeps building the short link off that base", () => {
    expect(src).toContain("${landingBase()}/e/${slug}");
  });
});
