// BF_SERVER_FRAUD_HOLD_v48
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApplicationStage,
  PIPELINE_STATES,
  canTransition,
  isParkedState,
  isPipelineState,
  statusFromPipeline,
} from "../pipelineState.js";
import {
  historicalStageFilter,
  isExcludedFromAllReporting,
  isExcludedFromLiveReporting,
  liveStageFilter,
} from "../reportingScope.js";

describe("Fraud and Hold stages", () => {
  it("are real pipeline states", () => {
    expect(isPipelineState("Fraud")).toBe(true);
    expect(isPipelineState("Hold")).toBe(true);
    expect(PIPELINE_STATES).toContain(ApplicationStage.FRAUD);
    expect(PIPELINE_STATES).toContain(ApplicationStage.HOLD);
  });

  it("are reachable from every working stage, including a funded deal", () => {
    expect(canTransition(ApplicationStage.ACCEPTED, ApplicationStage.FRAUD)).toBe(true);
    expect(canTransition(ApplicationStage.RECEIVED, ApplicationStage.HOLD)).toBe(true);
    expect(canTransition(ApplicationStage.OFF_TO_LENDER, ApplicationStage.FRAUD)).toBe(true);
  });

  it("let a held file return to the stage it left", () => {
    expect(canTransition(ApplicationStage.HOLD, ApplicationStage.OFF_TO_LENDER)).toBe(true);
    expect(canTransition(ApplicationStage.HOLD, ApplicationStage.ACCEPTED)).toBe(true);
  });

  it("keeps the working stages' existing transitions intact", () => {
    expect(canTransition(ApplicationStage.RECEIVED, ApplicationStage.IN_REVIEW)).toBe(true);
    expect(canTransition(ApplicationStage.IN_REVIEW, ApplicationStage.OFF_TO_LENDER)).toBe(true);
    expect(canTransition(ApplicationStage.RECEIVED, ApplicationStage.ACCEPTED)).toBe(false);
  });

  it("recognises parked stages", () => {
    expect(isParkedState("Fraud")).toBe(true);
    expect(isParkedState("Hold")).toBe(true);
    expect(isParkedState("Accepted")).toBe(false);
  });

  it("maps to statuses allowed by applications_status_check", () => {
    expect(statusFromPipeline(ApplicationStage.FRAUD)).toBe("DECLINED");
    expect(statusFromPipeline(ApplicationStage.HOLD)).toBe("IN_REVIEW");
  });
});

describe("reporting scope", () => {
  it("removes fraud from every count, in every period", () => {
    expect(isExcludedFromAllReporting("Fraud")).toBe(true);
    expect(historicalStageFilter()).toContain("'Fraud'");
  });

  it("leaves held files in the history they were already counted in", () => {
    expect(isExcludedFromAllReporting("Hold")).toBe(false);
    expect(historicalStageFilter()).not.toContain("'Hold'");
  });

  it("removes both from live pipeline, dashboard, and commission figures", () => {
    expect(isExcludedFromLiveReporting("Fraud")).toBe(true);
    expect(isExcludedFromLiveReporting("Hold")).toBe(true);
    expect(liveStageFilter()).toContain("'Fraud'");
    expect(liveStageFilter()).toContain("'Hold'");
  });

  it("counts a working stage normally", () => {
    expect(isExcludedFromLiveReporting("Accepted")).toBe(false);
    expect(isExcludedFromAllReporting("Accepted")).toBe(false);
  });

  it("targets a chosen column so aliased queries can use it", () => {
    expect(liveStageFilter("a.pipeline_state")).toContain("a.pipeline_state");
  });
});

describe("dashboard applies the filter", () => {
  const dashboard = readFileSync("src/routes/dashboard.ts", "utf8");

  it("filters the headline count, funded count, board counts, and commission", () => {
    expect((dashboard.match(/liveStageFilter\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
