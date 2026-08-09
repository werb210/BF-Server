// BF_SERVER_SEND_JOBS_SUBJECT_v36 + BF_SERVER_CANCEL_REASON_v36 source assertions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/marketing.ts"), "utf8");

describe("scheduled sends list exposes the campaign name", () => {
  it("both send-job reads select the subject out of the payload", () => {
    expect((src.match(/payload->>'subject' AS subject/g) || []).length).toBe(2);
  });

  it("also carries the template id so the portal can link back", () => {
    expect((src.match(/payload->>'templateId' AS template_id/g) || []).length).toBe(2);
  });

  it("still reports the hold window and the kill switch flag", () => {
    expect((src.match(/cancel_requested, payload->>'subject'/g) || []).length).toBe(2);
    expect(src).toContain("finished_at, not_before,");
  });
});

describe("cancel explains itself when it cannot cancel", () => {
  it("reads back the terminal status instead of a bare reason string", () => {
    expect(src).toContain('reason: status ? "already finished" : "not found"');
    expect(src).toContain("SELECT status FROM marketing_send_jobs WHERE id = $1 AND silo = $2");
  });
});
