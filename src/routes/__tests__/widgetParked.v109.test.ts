// BF_SERVER_WIDGET_PARKED_v109
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  liveStageFilter,
  LIVE_EXCLUDED_STAGES,
  ALWAYS_EXCLUDED_STAGES,
} from "../../modules/applications/reportingScope.js";

const widget = readFileSync(resolve(__dirname, "..", "widgetSummary.ts"), "utf-8");
const dashboard = readFileSync(resolve(__dirname, "..", "dashboard.ts"), "utf-8");

describe("reporting scope", () => {
  it("Fraud is excluded from every period", () => {
    expect(ALWAYS_EXCLUDED_STAGES).toContain("Fraud");
  });
  it("Hold is excluded from live figures", () => {
    expect(LIVE_EXCLUDED_STAGES).toContain("Hold");
    expect(LIVE_EXCLUDED_STAGES).toContain("Fraud");
  });
  it("the filter names both parked states", () => {
    const sql = liveStageFilter("a.pipeline_state");
    expect(sql).toContain("Fraud");
    expect(sql).toContain("Hold");
    expect(sql).toContain("a.pipeline_state");
  });
});

describe("widget summary", () => {
  it("uses the shared filter rather than its own stage list", () => {
    expect(widget).toContain("liveStageFilter");
    expect(widget).toContain('reportingScope.js');
  });

  it("applies it inside REAL_DEAL so every count inherits it", () => {
    const i = widget.indexOf("const REAL_DEAL");
    const j = widget.indexOf("`;", i);
    expect(widget.slice(i, j)).toContain("liveStageFilter");
  });

  it("now agrees with the dashboard", () => {
    // These two surfaces report the same numbers to the same people.
    expect(dashboard).toContain("liveStageFilter");
    expect(widget).toContain("liveStageFilter");
  });

  it("documents why the funded_amount arm needed constraining", () => {
    expect(widget).toContain("bypassed every stage test");
  });
});
