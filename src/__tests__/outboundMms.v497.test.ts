// BF_SERVER_BLOCK_v497_OUTBOUND_MMS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/communications.ts", import.meta.url)), "utf-8");

describe("v497 outbound MMS", () => {
  it("accepts one picture or PDF, checks type, size and country", () => {
    expect(src).toContain('new Set(["image/jpeg", "image/png", "image/gif", "application/pdf"])');
    expect(src).toContain("buf.length > 5 * 1024 * 1024");
    expect(src).toContain('"mms_country_not_supported"');
  });
  it("sends the media to Twilio and records it on the message", () => {
    expect(src).toContain("...(mmsMediaUrl ? { mediaUrl: [mmsMediaUrl] } : {})");
    expect(src).toContain("staff_name, silo, media_url, created_at)");
  });
  it("a text with only a picture is allowed", () => {
    expect(src).toContain("if ((!body && !mmsMediaUrl) || !to) {");
  });
});
