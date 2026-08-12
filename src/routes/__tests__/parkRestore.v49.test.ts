// BF_SERVER_PARK_RESTORE_v49
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isParkedState, PARKED_STATES, ApplicationStage } from "../../modules/applications/pipelineState.js";

const portal = readFileSync("src/routes/portal.ts", "utf8");

describe("parking an application", () => {
  it("accepts Fraud and Hold as manual status targets", () => {
    // Before this the route allowed only Additional Steps / Accepted / Rejected,
    // so the new columns would have 400'd on every drop.
    expect(portal).toContain("...PARKED_STATES");
    expect(PARKED_STATES).toEqual([ApplicationStage.FRAUD, ApplicationStage.HOLD]);
  });

  it("accepts the working stages so a parked file can be brought back", () => {
    expect(portal).toContain("ApplicationStage.OFF_TO_LENDER,");
    expect(portal).toContain("ApplicationStage.IN_REVIEW,");
  });

  it("requires a reason before marking fraud", () => {
    expect(portal).toContain("A reason is required when marking an application as fraud.");
  });

  it("records where the file came from when parking", () => {
    expect(portal).toContain("SET parked_previous_stage = $2");
    expect(portal).toContain("fraud_confirmed_at");
  });

  it("clears the park details when the file returns to work", () => {
    expect(portal).toContain("SET parked_previous_stage = NULL");
  });

  it("sends the park details to the board", () => {
    expect(portal).toContain("a.parked_previous_stage");
    expect(portal).toContain("a.parked_reason");
  });
});

describe("isParkedState", () => {
  it("distinguishes parked from working stages", () => {
    expect(isParkedState("Fraud")).toBe(true);
    expect(isParkedState("Hold")).toBe(true);
    expect(isParkedState("Off to Lender")).toBe(false);
    expect(isParkedState(null)).toBe(false);
  });
});
