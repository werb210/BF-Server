// BF_SERVER_CSP_BRAND_FONTS_v229
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app.ts", "utf-8");
const csp = app.slice(
  app.indexOf("contentSecurityPolicy:"),
  app.indexOf("app.use(cors"),
);

describe("brand fonts are allowed by the CSP", () => {
  it("permits the Google Fonts stylesheet", () => {
    expect(app).toMatch(/styleSrc: \[[\s\S]*?https:\/\/fonts\.googleapis\.com/);
  });

  it("permits the woff2 files themselves", () => {
    expect(app).toMatch(/fontSrc: \[[\s\S]*?https:\/\/fonts\.gstatic\.com/);
  });

  it("permits the service worker to fetch them", () => {
    // sw.js fetching a font is a connect, not a font load. Allowing it under
    // fontSrc alone still fails with ERR_FAILED in the console.
    const connect = app.slice(app.indexOf("connectSrc: ["), app.indexOf("mediaSrc"));
    expect(connect).toContain("https://fonts.gstatic.com");
  });

  it("does not loosen the policy beyond the font hosts", () => {
    // A wildcard here would defeat the point of having a CSP at all.
    expect(csp).not.toContain('"*"');
    expect(csp).not.toMatch(/connectSrc: \[[\s\S]*?"https:"/);
  });

  it("keeps every origin the app already depended on", () => {
    for (const origin of [
      "https://server.boreal.financial",
      "wss://server.boreal.financial",
      "https://staff.boreal.financial",
      "https://voice-js.twilio.com",
      "wss://eventgw.twilio.com",
    ]) {
      expect(app).toContain(origin);
    }
  });
});
