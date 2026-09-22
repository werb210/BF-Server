// BF_SERVER_ADS_WORKER_HEARTBEAT_v407
// BF_SERVER_NOTIFICATION_READ_IDEMPOTENT_v407
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("v407 operational visibility", () => {
  it("the ad-conversion worker logs one line on every tick", () => {
    const src = read("src/workers/adConversionWorker.ts");
    expect(src).toContain("BF_SERVER_ADS_WORKER_HEARTBEAT_v407");
    expect(src).toContain('console.log("[ads_conversion] tick"');
    expect(src).not.toContain("if (submit.configured");
    expect(src).not.toContain("if (funded.configured");
  });
  it("the tick line carries every stage so an idle pass is still visible", () => {
    const src = read("src/workers/adConversionWorker.ts");
    for (const key of ["submit,", "qualified,", "retracted,", "funded,", "attribution,", "customerMatch,"]) expect(src).toContain(key);
  });
  it("marking a notification read twice is no longer an error", () => {
    const svc = read("src/services/notifications/notifications.service.ts");
    expect(svc).toContain("BF_SERVER_NOTIFICATION_READ_IDEMPOTENT_v407");
    expect(svc).not.toContain("WHERE id = $1 AND user_id = $2 AND is_read = false");
    expect(svc).toContain("read_at = COALESCE(read_at, now())");
  });
  it("an unknown notification id still answers 404", () => {
    const route = read("src/routes/notifications.ts");
    expect(route).toContain('"Notification not found."');
    expect(route).not.toContain("or already read");
  });
  it("mark-all-read is untouched", () => {
    const svc = read("src/services/notifications/notifications.service.ts");
    expect(svc).toContain("WHERE user_id = $1 AND is_read = false");
  });
});
