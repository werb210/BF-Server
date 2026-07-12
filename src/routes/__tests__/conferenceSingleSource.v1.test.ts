// BF_SERVER_CONFERENCE_SINGLE_SOURCE_v1 - there were two conferenceService.ts
// files. src/voice/conferenceService.ts is the live one (every conference route
// imports it); src/telephony/services/conferenceService.ts was imported by
// nothing. Dead duplicates have repeatedly caused wasted work, so this test
// keeps the tree honest: exactly one conference service, and it is the live one.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_CONFERENCE_SINGLE_SOURCE_v1", () => {
  it("keeps the live conference service", () => {
    expect(existsSync(join(process.cwd(), "src/voice/conferenceService.ts"))).toBe(true);
  });

  it("does not resurrect the dead telephony duplicate", () => {
    expect(existsSync(join(process.cwd(), "src/telephony/services/conferenceService.ts"))).toBe(false);
  });

  it("routes still import the live service", () => {
    const webhooks = readFileSync(join(process.cwd(), "src/routes/conferenceWebhooks.ts"), "utf8");
    expect(webhooks).toContain("../voice/conferenceService.js");
  });
});
