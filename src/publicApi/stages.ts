// BF_SERVER_v875_API_KEYS (ported from KS-server #35) - the stages an API client may move an application to: every
// working pipeline stage. The parking stages (Fraud, Hold) have their own staff-only flow and are not offered here; the
// normal transition rules (funding conditions before Funded, and the rest) still apply to every move.
import { PARKED_STATES, PIPELINE_STATES } from "../modules/applications/pipelineState.js";

export const API_STAGES: string[] = PIPELINE_STATES.filter((s) => !PARKED_STATES.includes(s));

export function isApiStage(v: unknown): v is string {
  return typeof v === "string" && API_STAGES.includes(v);
}
