// BF_SERVER_TEAMS_MEETINGS_UPSERT_FIX_v1
// Regression guard for a real outage: a partial unique index cannot be inferred
// by a bare `ON CONFLICT (col)`, so the upsert threw on every meeting, and a
// bare `catch {}` hid it. Both halves are pinned here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const meetings = readFileSync(join(process.cwd(), "src/routes/crm/meetings.ts"), "utf8");
const fixSql = readFileSync(
  join(process.cwd(), "migrations/2026_07_12_teams_meetings_fix_upsert.sql"),
  "utf8",
);

describe("teams_meetings upsert", () => {
  it("uses a NON-partial unique index so ON CONFLICT can infer it", () => {
    expect(fixSql).toContain("DROP INDEX IF EXISTS teams_meetings_graph_event_uidx");
    expect(fixSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx");
    expect(fixSql).not.toMatch(/teams_meetings_graph_event_uidx[\s\S]*WHERE graph_event_id IS NOT NULL/);
  });

  it("never swallows the registration failure silently again", () => {
    expect(meetings).toContain("teams_meeting_register_failed");
    expect(meetings).not.toContain("catch { /* never break the meeting create */ }");
  });

  it("still upserts on graph_event_id", () => {
    expect(meetings).toContain("ON CONFLICT (graph_event_id) DO UPDATE");
  });
});
