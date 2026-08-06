// BF_SERVER_TEMPLATE_SAVE_BY_NAME_v18
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { slugFromLandingUrl } from "../services/landingPage.service.js";

const routes = fs.readFileSync(path.resolve(__dirname, "../routes/marketing.ts"), "utf8");

describe("saving a template under an existing name", () => {
  it("looks for a prior template with the same silo, channel and name", () => {
    expect(routes).toContain("WHERE silo = $1 AND channel = $2 AND name = $3");
  });

  it("updates the prior row instead of inserting a duplicate", () => {
    expect(routes).toContain("UPDATE marketing_template");
    expect(routes).toContain("replaced = true");
  });

  it("keeps the existing landing page slug so sent links stay live", () => {
    expect(routes).toContain("updateLandingPageHtml(priorSlug");
    expect(routes).toContain("landingUrl = landingUrlForSlug(priorSlug)");
  });

  it("adds no UNIQUE constraint, which would crash-loop on existing duplicates", () => {
    const dir = path.resolve(__dirname, "../../migrations");
    const sql = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    expect(sql).not.toMatch(/UNIQUE[^;]*marketing_template[^;]*name/i);
  });
});

describe("slugFromLandingUrl", () => {
  it("pulls the slug out of a landing URL", () => {
    expect(slugFromLandingUrl("https://www.boreal.financial/e/jdwfpnc5zc")).toBe("jdwfpnc5zc");
  });
  it("returns null for anything else", () => {
    expect(slugFromLandingUrl("https://www.boreal.financial/apply")).toBeNull();
    expect(slugFromLandingUrl(null)).toBeNull();
  });
});
