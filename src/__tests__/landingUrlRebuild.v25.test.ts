// BF_SERVER_LANDING_URL_REBUILD_v25
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { landingUrlForSlug, slugFromLandingUrl } from "../services/landingPage.service.js";

const routes = fs.readFileSync(path.resolve(__dirname, "../routes/marketing.ts"), "utf8");

describe("landing URL rebuild on re-save", () => {
  it("no longer hands back the stored link_url", () => {
    expect(routes).not.toContain("landingUrl = priorRow.link_url;");
    expect(routes).toContain("landingUrl = landingUrlForSlug(priorSlug);");
  });

  it("rebuilds from the current base while preserving the slug", () => {
    const previousBase = process.env.LANDING_BASE_URL;
    process.env.LANDING_BASE_URL = "https://landing.example.test/root/";

    try {
      const slug = slugFromLandingUrl("https://broken.example.test/e/stable_slug");
      expect(slug).toBe("stable_slug");
      expect(landingUrlForSlug(slug!)).toBe("https://landing.example.test/root/e/stable_slug");
    } finally {
      if (previousBase === undefined) delete process.env.LANDING_BASE_URL;
      else process.env.LANDING_BASE_URL = previousBase;
    }
  });
});
