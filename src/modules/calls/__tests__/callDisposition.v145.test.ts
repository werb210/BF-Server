import { describe, expect, it } from "vitest";
import {
  CALL_DISPOSITIONS,
  followUpFor,
  isCallDisposition,
  planForDisposition,
  suppressesOutreach,
  timelineLabel,
} from "../callDisposition.js";

describe("BF_SERVER_CALL_DISPOSITION_v145", () => {
  it("accepts every documented outcome and rejects unknown values", () => {
    for (const disposition of CALL_DISPOSITIONS) expect(isCallDisposition(disposition)).toBe(true);
    for (const value of ["maybe", "", null, 7]) expect(isCallDisposition(value)).toBe(false);
  });

  it("spawns follow-up work only for outcomes that imply work", () => {
    expect(followUpFor("follow_up")).toEqual({ label: "Follow up on call", days: 2 });
    expect(followUpFor("documents_promised")?.days).toBe(3);
    expect(followUpFor("needs_lender_review")?.days).toBe(1);
    expect(followUpFor("demo_booked")?.days).toBe(1);
    for (const outcome of ["no_answer", "left_voicemail", "connected", "not_interested", "do_not_contact"])
      expect(followUpFor(outcome)).toBeNull();
  });

  it("suppresses future outreach only for do-not-contact", () => {
    expect(suppressesOutreach("do_not_contact")).toBe(true);
    expect(suppressesOutreach("not_interested")).toBe(false);
  });

  it("writes readable timeline notes", () => {
    expect(timelineLabel("documents_promised")).toBe("Call outcome: documents promised");
    expect(timelineLabel("no_answer")).toBe("Call outcome: no answer");
  });

  it("plans the full effect and rejects unknown outcomes", () => {
    expect(planForDisposition("documents_promised")).toMatchObject({
      followUp: { label: "Collect promised documents" },
      timelineNote: "Call outcome: documents promised",
      suppressOutreach: false,
    });
    expect(planForDisposition("nonsense")).toBeNull();
    expect(planForDisposition(undefined)).toBeNull();
  });

  it("keeps every follow-up within a working week", () => {
    for (const disposition of CALL_DISPOSITIONS) {
      const rule = followUpFor(disposition);
      if (!rule) continue;
      expect(rule.days).toBeGreaterThan(0);
      expect(rule.days).toBeLessThanOrEqual(5);
    }
  });
});
