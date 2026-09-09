// BF_SERVER_JOB_QUEUE_VISIBILITY_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.resolve(__dirname, "../internal.ts"), "utf8");

describe("job queue visibility", () => {
  it("reads job_queue, not the unrelated tables the other endpoints use", () => {
    // /jobs returns replay jobs; /failed-jobs reads failed_jobs. Neither shows
    // the queue that dispatches lender packages.
    expect(route).toContain("FROM job_queue");
  });

  it("reports what is claimable now, using the worker's own predicate", () => {
    // Must match lenderPackageWorker's claim condition or the number is a lie.
    expect(route).toContain("COALESCE(next_attempt_at, created_at) <= now()");
  });

  it("surfaces jobs stuck for over an hour with their payload", () => {
    expect(route).toContain("created_at < now() - interval '1 hour'");
    expect(route).toContain("payload");
  });

  it("shows attempt counts so a retry loop is visible", () => {
    expect(route).toContain("COALESCE(attempts, 0)");
  });

  it("bounds the detail query", () => {
    expect(route).toMatch(/stuckOverAnHour[\s\S]{0,80}/);
    expect(route).toContain("LIMIT 50");
  });
});
