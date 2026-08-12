// BF_SERVER_FRAUD_HOLD_v48
// Fraud is never reported. Hold is omitted only from live/current reporting,
// because previously reported periods remain valid while a client is paused.

import { ApplicationStage } from "./pipelineState.js";

export const ALWAYS_EXCLUDED_STAGES: readonly string[] = [ApplicationStage.FRAUD];

export const LIVE_EXCLUDED_STAGES: readonly string[] = [
  ApplicationStage.FRAUD,
  ApplicationStage.HOLD,
];

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

export function liveStageFilter(column = "pipeline_state"): string {
  return `AND COALESCE(${column}, '') NOT IN (${sqlList(LIVE_EXCLUDED_STAGES)})`;
}

export function historicalStageFilter(column = "pipeline_state"): string {
  return `AND COALESCE(${column}, '') NOT IN (${sqlList(ALWAYS_EXCLUDED_STAGES)})`;
}

export function isExcludedFromLiveReporting(stage: string | null | undefined): boolean {
  return LIVE_EXCLUDED_STAGES.includes(String(stage ?? ""));
}

export function isExcludedFromAllReporting(stage: string | null | undefined): boolean {
  return ALWAYS_EXCLUDED_STAGES.includes(String(stage ?? ""));
}
