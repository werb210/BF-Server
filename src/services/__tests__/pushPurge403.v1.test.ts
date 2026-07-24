// BF_SERVER_PUSH_PURGE_403_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../pushService.ts", import.meta.url)),
  "utf-8",
);

describe("dead push subscriptions are dropped, not retried forever", () => {
  it("treats 403 as terminal", () => {
    expect(src).toContain("statusCode === 403");
  });

  it("still treats the standard gone responses as terminal", () => {
    for (const code of ["400", "403", "404", "410"]) {
      expect(src).toContain("statusCode === " + code);
    }
  });

  it("does not drop a subscription on a transient server-side failure", () => {
    // 429 and 5xx are retryable; dropping on those would unsubscribe staff
    // every time a push service had a bad minute.
    for (const code of ["429", "500", "502", "503"]) {
      expect(src).not.toContain("statusCode === " + code);
    }
  });

  it("records whether the row was dropped so the log is diagnosable", () => {
    expect(src).toContain("subscriptionDropped: dropped");
  });
});
