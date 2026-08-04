// BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = readFileSync(
  fileURLToPath(new URL("../services/marketingSendRunner.ts", import.meta.url)),
  "utf-8",
);
const route = readFileSync(
  fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)),
  "utf-8",
);

describe("resend override", () => {
  it("skips the 24h dedupe when asked", () => {
    expect(runner).toContain("job.resend ? { rowCount: 0, rows: [] as { id: string }[] }");
  });

  it("keeps the dedupe on by default - a resumed blast must not double-send", () => {
    expect(runner).toContain("interval '24 hours'");
    expect(runner).toContain("resend?: boolean");
  });

  it("carries the flag onto the queued job so the worker honours it", () => {
    expect(route).toContain("resend: b.resend === true");
  });
});
