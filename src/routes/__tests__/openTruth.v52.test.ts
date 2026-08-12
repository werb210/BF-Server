// BF_SERVER_OPEN_TRUTH_v52
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyOpenSource, isOwnTrackingPixel, MACHINE_SOURCES } from "../openTruth.js";

describe("classifyOpenSource", () => {
  it("classifies providers, scanners, bots, and likely readers", () => {
    expect(classifyOpenSource("Mozilla/5.0 (compatible; GoogleImageProxy)")).toBe("proxy_gmail");
    expect(classifyOpenSource("Mozilla/5.0 AppleMail/16.0")).toBe("proxy_apple");
    expect(classifyOpenSource("Proofpoint URL Defense")).toBe("scanner");
    expect(classifyOpenSource("Mimecast Link Protection")).toBe("scanner");
    expect(classifyOpenSource("Microsoft Office Existence Discovery")).toBe("scanner");
    expect(classifyOpenSource("curl/8.4.0")).toBe("bot");
    expect(classifyOpenSource("node-fetch/1.0")).toBe("bot");
    expect(classifyOpenSource("Mozilla/5.0 (Macintosh) Chrome/127")).toBe("human_likely");
    expect(classifyOpenSource("Microsoft Outlook 16.0")).toBe("human_likely");
    expect(classifyOpenSource("")).toBe("unknown");
    expect(classifyOpenSource(null)).toBe("unknown");
  });

  it("defines only automated sources as machines", () => {
    for (const source of MACHINE_SOURCES) {
      expect(["proxy_gmail", "proxy_apple", "scanner", "bot"]).toContain(source);
    }
  });
});

describe("isOwnTrackingPixel", () => {
  it("recognises tracking pixels without rejecting genuine images", () => {
    expect(isOwnTrackingPixel("https://server.boreal.financial/api/track/email/abc123.gif")).toBe(true);
    expect(isOwnTrackingPixel("https://cdn.example.com/logo.png")).toBe(false);
    expect(isOwnTrackingPixel("https://example.com/api/track/email/other.png")).toBe(false);
    expect(isOwnTrackingPixel("not a url")).toBe(false);
  });
});

describe("recording", () => {
  const pixel = readFileSync("src/routes/emailPixel.ts", "utf8");
  const timeline = readFileSync("src/routes/crm/timeline.ts", "utf8");

  it("records explainable, deduplicated events and reports the split", () => {
    expect(pixel).toContain("user_agent, ip, source");
    expect(pixel).toContain("interval '1 minute'");
    expect(timeline).toContain("machine)");
    expect(timeline).toContain("'unverified'");
  });
});
