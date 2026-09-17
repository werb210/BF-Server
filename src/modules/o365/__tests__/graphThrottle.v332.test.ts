// BF_SERVER_GRAPH_THROTTLE_v332
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isReplayableBody, retryAfterMs } from "../graphClient.js";

const client = readFileSync(resolve(__dirname, "..", "graphClient.ts"), "utf-8");

describe("Retry-After is honoured, not ignored", () => {
  it("takes a plain number as seconds", () => expect(retryAfterMs("3", 0)).toBe(3000));
  it("takes an HTTP date as an absolute moment", () => {
    const now = Date.parse("2026-09-17T18:57:00Z");
    expect(retryAfterMs("Thu, 17 Sep 2026 18:57:05 GMT", 0, now)).toBe(5000);
  });
  it("never waits longer than the cap", () => expect(retryAfterMs("600", 0)).toBe(20_000));
  it("treats a past date as no wait", () => {
    const now = Date.parse("2026-09-17T18:57:00Z");
    expect(retryAfterMs("Thu, 17 Sep 2026 18:56:00 GMT", 0, now)).toBe(0);
  });
  it("backs off when Microsoft sends no valid header", () => {
    expect(retryAfterMs(null, 0)).toBe(1000);
    expect(retryAfterMs("", 1)).toBe(2000);
    expect(retryAfterMs("not a header", 2)).toBe(4000);
  });
});

describe("a retry must not corrupt the request", () => {
  it("replays an absent or string body", () => {
    expect(isReplayableBody(undefined)).toBe(true);
    expect(isReplayableBody(null)).toBe(true);
    expect(isReplayableBody(JSON.stringify({ subject: "x" }))).toBe(true);
  });
  it("refuses to replay non-string bodies", () => {
    expect(isReplayableBody(new ReadableStream())).toBe(false);
    expect(isReplayableBody(new URLSearchParams({ a: "b" }))).toBe(false);
  });
});

describe("the mailbox concurrency limit", () => {
  it("caps in-flight calls per user at four", () => {
    expect(client).toContain("const GRAPH_MAX_CONCURRENT_PER_USER = 4;");
    expect(client).toContain("withMailboxSlot(userId, async () => {");
  });
  it("retries 429 and 503", () => expect(client).toContain("(resp.status === 429 || resp.status === 503)"));
  it("records persistent throttling", () => {
    expect(client).toContain('stage: "graph_throttled"');
    expect(client).toContain('event: "graph_throttled_retry"');
  });
  it("releases the slot when calls throw", () => expect(client).toContain("} finally {\n    held.active -= 1;"));
});
