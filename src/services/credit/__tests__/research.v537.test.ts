// BF_SERVER_BLOCK_v537_RESEARCH_PACK
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

vi.mock("../../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
vi.mock("../../crm/contactBrief.js", () => ({
  businessDomain: (website: unknown, email: unknown) => website
    ? String(website).replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")
    : /@(.+)$/.exec(String(email ?? ""))?.[1] ?? null,
  companyBackground: vi.fn(async () => null),
}));

import { cacheKey, companyRefFrom, googlePlace, normalizeWebFacts, placesFacts } from "../research.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_PLACES_API_KEY;
});

describe("v537 who to research", () => {
  it("takes the business from the wizard or broker import, else the application name", () => {
    expect(companyRefFrom({ name: "App", metadata: { business: { legalName: "Pro-Pipe Service & Sales Ltd.", city: "Nisku", state: "AB", website: "propipecanada.com" } } }, null))
      .toEqual({ name: "Pro-Pipe Service & Sales Ltd.", city: "Nisku", province: "AB", website: "propipecanada.com", email: null });
    expect(companyRefFrom({ name: "ABS Truck and Trailer", metadata: {} }, "a@abstruckparts.com")?.name).toBe("ABS Truck and Trailer");
    expect(companyRefFrom({ metadata: {} }, null)).toBeNull();
  });

  it("caches by domain when there is one, else by name and province", () => {
    expect(cacheKey({ name: "X", city: null, province: null, website: "https://www.propipecanada.com", email: null })).toBe("domain:propipecanada.com");
    expect(cacheKey({ name: "A&W Farms", city: null, province: "ON", website: null, email: null })).toBe("name:a w farms|on");
  });
});

describe("v537 web and registry facts", () => {
  it("keeps only facts with a source link, and files registry facts separately", () => {
    const facts = normalizeWebFacts({ facts: [
      { category: "registry", label: "Incorporated", value: "Alberta, 1998-03-12, active", url: "https://www.alberta.ca/registry" },
      { category: "news", label: "Contract win", value: "Awarded a 2024 supply contract", url: "https://news.example.com/a" },
      { category: "risk", label: "Rumour", value: "no source given", url: "" },
      { category: "history", label: "Bad link", value: "x", url: "javascript:alert(1)" },
    ] });
    expect(facts.map((fact) => [fact.source, fact.label])).toEqual([["registry", "Incorporated"], ["web", "Contract win"]]);
    expect(normalizeWebFacts(null)).toEqual([]);
  });
});

describe("v537 Google Business profile", () => {
  it("skips cleanly without a key", async () => {
    expect(await googlePlace({ name: "X", city: null, province: null, website: null, email: null })).toBeNull();
  });

  it("maps the first match into facts", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ places: [{
      displayName: { text: "ABS Truck & Trailer Parts" },
      formattedAddress: "6030 125 Ave NW, Edmonton, AB",
      businessStatus: "OPERATIONAL",
      rating: 4.6,
      userRatingCount: 212,
      googleMapsUri: "https://maps.google.com/?cid=1",
    }] }) })));
    const facts = placesFacts(await googlePlace({ name: "ABS Truck and Trailer", city: "Edmonton", province: "AB", website: null, email: null }));
    expect(facts.find((fact) => fact.label === "Google rating")?.value).toBe("4.6 from 212 reviews");
    expect(facts.find((fact) => fact.label === "Status")?.value).toBe("Operational");
    expect(facts.every((fact) => fact.source === "google" && fact.url === "https://maps.google.com/?cid=1")).toBe(true);
  });
});

describe("v537 wiring", () => {
  it("mounts the route and stores web and registry facts as unverified", () => {
    expect(fs.readFileSync("src/routes/routeRegistry.ts", "utf8")).toMatch(/path: "\/credit-research", router: creditResearchRoutes/);
    expect(fs.readFileSync("src/services/credit/research.ts", "utf8")).toContain('fact.source === "registry" || fact.source === "web" ? "unverified" : "reported"');
  });
});
