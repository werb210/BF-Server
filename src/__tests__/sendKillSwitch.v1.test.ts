// BF_SERVER_SEND_KILL_SWITCH_v1 + BF_SERVER_DEADLETTER_UNJAM_v1 source assertions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("send kill switch v1", () => {
  it("migration adds cancel_requested idempotently", () => {
    expect(read("migrations/2026_07_08_send_cancel_requested.sql")).toMatch(/ADD COLUMN IF NOT EXISTS cancel_requested/);
  });

  it("both runners accept shouldAbort and return aborted", () => {
    const s = read("src/services/marketingSendRunner.ts");
    expect(s).toContain("export type ShouldAbort");
    expect((s.match(/shouldAbort\?: ShouldAbort/g) || []).length).toBe(2);
    expect(s).toContain("aborted = true; break;");
  });

  it("worker supplies abortCheck and marks canceled instead of done on abort", () => {
    const s = read("src/workers/sendQueueWorker.ts");
    expect(s).toContain("SELECT cancel_requested FROM marketing_send_jobs");
    expect(s).toContain("result.aborted ? 'canceled' : 'done'");
  });

  it("cancel route stops running jobs via cancel_requested", () => {
    const s = read("src/routes/marketing.ts");
    expect(s).toContain("SET cancel_requested=true");
    expect(s).toContain('phase: "stopping"');
  });
});

describe("dead-letter unjam v1", () => {
  it("worker filters abandoned jobs out of the active queue and prunes old ones", () => {
    const s = read("src/workers/deadLetterWorker.ts");
    expect(s).toContain("WHERE retry_count < $1 ORDER BY created_at ASC");
    expect(s).toMatch(/DELETE FROM failed_jobs WHERE retry_count >= \$1 AND created_at </);
  });
});
