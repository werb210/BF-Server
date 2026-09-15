// BF_SERVER_WATCH_SNAPSHOT_TASKS_v209
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snap = readFileSync("src/watch/snapshotRoutes.ts", "utf-8");
const dispositions = readFileSync("src/modules/calls/callDisposition.ts", "utf-8");
const briefing = readFileSync("src/routes/mayaStaff.ts", "utf-8");

describe("the missed-call count that never worked", () => {
  it("no longer reads a column call_logs does not have", () => {
    // migration 043 defines staff_user_id; there is no user_id on call_logs.
    expect(snap).not.toMatch(/FROM call_logs[\s\S]{0,160}user_id = \$1/);
  });

  it("no longer matches a disposition that is not in the catalogue", () => {
    expect(dispositions).not.toContain('"missed"');
    expect(snap).not.toContain("disposition = 'missed'");
  });

  it("uses the same source daily-briefing already uses correctly", () => {
    expect(snap).toContain("FROM call_events");
    expect(snap).toContain("event_type = 'call.missed'");
    expect(briefing).toContain("event_type = 'call.missed'");
  });

  it("still counts from the start of today, not all time", () => {
    expect(snap).toMatch(/event_type = 'call\.missed'[\s\S]{0,120}date_trunc\('day', now\(\)\)/);
  });
});

describe("tasks due", () => {
  it("counts tasks assigned to the user", () => {
    expect(snap).toContain("assignee_user_id = $1::uuid");
  });

  it("includes overdue tasks, not just today's", () => {
    // A count that silently drops a task once it is late is worse than none.
    expect(snap).toContain("due_at < date_trunc('day', now()) + interval '1 day'");
    expect(snap).not.toMatch(/due_at >= date_trunc\('day', now\(\)\)/);
  });

  it("excludes non-open task statuses", () => {
    for (const done of ["COMPLETED", "DEFERRED"]) {
      expect(snap).toContain(`'${done}'`);
    }
  });

  it("ignores tasks with no due date", () => {
    expect(snap).toContain("due_at IS NOT NULL");
  });

  it("is returned to the watch", () => {
    expect(snap).toContain("tasksDue: Number(tasksDue.rows[0]?.count ?? 0)");
  });
});

describe("the snapshot cannot fail the watch", () => {
  it("every query degrades to a zero rather than throwing", () => {
    expect(snap.match(/\.catch\(\(\) => \(\{ rows: \[\{ count: "0" \}\] \}\)\)/g)?.length).toBe(2);
  });

  it("makes no Graph call - the watch must not wait on O365", () => {
    expect(snap).not.toMatch(/graph|calendar\/events/i);
  });
});
