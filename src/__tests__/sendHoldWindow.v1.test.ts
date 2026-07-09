// BF_SERVER_SEND_HOLD_WINDOW_v1 - source assertions: the hold + cancel stay wired.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("send hold window v1", () => {
  it("migration adds not_before idempotently", () => {
    const s = read("migrations/2026_07_08_send_hold_window.sql");
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS not_before/);
  });

  it("worker will not claim a job whose hold has not expired", () => {
    const s = read("src/workers/sendQueueWorker.ts");
    expect(s).toContain("not_before IS NULL OR not_before <= now()");
  });

  it("queued blasts are inserted with a future not_before and a cancel route exists", () => {
    const s = read("src/routes/marketing.ts");
    expect(s).toContain("SEND_HOLD_MINUTES");
    expect((s.match(/not_before\)/g) || []).length).toBeGreaterThanOrEqual(3); // 3 insert sites
    expect(s).toContain('router.post("/send-jobs/:id/cancel"');
    expect(s).toContain("status='queued' AND started_at IS NULL");
  });
});
