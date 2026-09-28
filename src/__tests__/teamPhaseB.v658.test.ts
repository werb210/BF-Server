// BF_SERVER_TEAM_PHASE_B_v658
import { describe, expect, it } from "vitest";
import { normalizeChannelName } from "../services/team/teamChannels.js";

describe("v658 channel names", () => {
  it("become lowercase with dashes and no symbols", () => {
    expect(normalizeChannelName("#Deals Team!")).toBe("deals-team");
    expect(normalizeChannelName("  Q4 -- Pipeline  ")).toBe("q4-pipeline");
    expect(normalizeChannelName("leads_ab")).toBe("leads_ab");
    expect(normalizeChannelName("###")).toBeNull();
    expect(normalizeChannelName("x".repeat(100))?.length).toBe(80);
  });
});
