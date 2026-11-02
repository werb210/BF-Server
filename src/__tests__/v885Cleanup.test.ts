// BF_SERVER_v885 - small wording fixes: durations in words, Alberta's zone name shown to staff.
import { describe, expect, it } from "vitest";
import { humanDuration } from "../lib/humanDuration.js";
import { readableReasons } from "../fraud/store.js";
import { brokerageTimeZone, brokerageZoneName } from "../settingsPack/boreal.js";
import { ALBERTA_TZ } from "../lib/albertaTime.js";
import { PERMANENT_ZONES } from "../lib/permanentTime.js";

describe("v885 durations", () => {
  it("reads a gap in sensible units", () => {
    expect(humanDuration(5 * 60_000)).toBe("5 minutes");
    expect(humanDuration(60_000)).toBe("1 minute");
    expect(humanDuration(3 * 3600_000)).toBe("3 hours");
    expect(humanDuration(5 * 86_400_000)).toBe("5 days");
    expect(humanDuration(3791521 * 60_000)).toBe("about 7 years");
  });
  it("old stored tamper reasons read in words", () => {
    const [r] = readableReasons([{ code: "modified_after_create", severity: "info", text: "The file was changed 3791521 minute(s) after it was created." }]);
    expect(r.text).toBe("The file was last changed about 7 years after it was created (dates stored in the PDF).");
  });
});

describe("v885 Alberta zone name", () => {
  it("staff see Alberta's zone name; times are still computed UTC-6 all year", () => {
    expect(brokerageTimeZone()).toBe(ALBERTA_TZ);
    expect(PERMANENT_ZONES[brokerageZoneName()]).toBe(ALBERTA_TZ);
    expect(brokerageZoneName()).not.toBe(ALBERTA_TZ);
  });
});

import { demoStepsDone, stepNumberIn } from "../modules/ks/ksCrm.js";
describe("v885 Keystone demo steps", () => {
  it("a card never shows fewer steps than the step reached", () => {
    expect(stepNumberIn("Reached step 9 of 9: Submit to lenders (completed).")).toBe(9);
    expect(stepNumberIn("Opened the demo for the first time.")).toBe(0);
    expect(demoStepsDone(8, "Reached step 9 of 9: Submit to lenders (completed).")).toBe(9);
    expect(demoStepsDone(9, "Status changed from pending_payment to cancelled")).toBe(9);
    expect(demoStepsDone(null, null)).toBe(0);
  });
});
