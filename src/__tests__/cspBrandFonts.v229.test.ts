// BF_SERVER_CSP_BRAND_FONTS_v229
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

// The policy the server actually sends, parsed into { directive: sources[] }.
let policy: Record<string, string[]> = {};
let raw = "";

beforeAll(async () => {
  const res = await request(createApp()).get("/health");
  raw = String(res.headers["content-security-policy"] ?? "");
  policy = Object.fromEntries(
    raw
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name, sources];
      }),
  );
});

describe("brand fonts are allowed by the CSP", () => {
  it("permits the Google Fonts stylesheet", () => {
    expect(policy["style-src"]).toContain("https://fonts.googleapis.com");
  });

  it("permits the woff2 files themselves", () => {
    expect(policy["font-src"]).toContain("https://fonts.gstatic.com");
  });

  it("permits the service worker to fetch them", () => {
    // sw.js fetching a font is a connect, not a font load. Allowing it under
    // fontSrc alone still fails with ERR_FAILED in the console.
    expect(policy["connect-src"]).toContain("https://fonts.gstatic.com");
  });

  it("does not loosen the policy beyond the font hosts", () => {
    // A wildcard here would defeat the point of having a CSP at all.
    expect(raw.length).toBeGreaterThan(0);
    for (const sources of Object.values(policy)) {
      expect(sources).not.toContain("*");
    }
    expect(policy["connect-src"]).not.toContain("https:");
  });

  it("keeps every origin the app already depended on", () => {
    for (const origin of [
      "https://server.boreal.financial",
      "wss://server.boreal.financial",
      "https://staff.boreal.financial",
      "https://voice-js.twilio.com",
      "wss://eventgw.twilio.com",
    ]) {
      expect(policy["connect-src"]).toContain(origin);
    }
  });
});
