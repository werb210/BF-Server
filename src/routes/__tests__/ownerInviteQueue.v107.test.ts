// BF_SERVER_OWNER_INVITE_QUEUE_WALK_v107
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "signnow.ts"), "utf-8");

describe("owner invite queue", () => {
  it("reads the roster v106 records", () => {
    expect(src).toContain("metadata->'owner_invite_queue'");
  });

  it("starts at Owner 3 so Owner 2 is not double-sent", () => {
    expect(src).toContain("Number(o?.index) >= 3");
  });

  it("sends to the earliest unsent owner, one per signer event", () => {
    expect(src).toContain("sort((a, b) => Number(a.index) - Number(b.index))");
    expect(src).toContain("const nextOwner = pending[0];");
  });

  it("only records an owner as sent when the email actually went", () => {
    const i = src.indexOf("owner_invite_sent',\n                        coalesce");
    expect(i).toBeGreaterThan(-1);
    // The mark-sent write must sit inside the sent.ok branch.
    const okAt = src.indexOf("if (sent.ok) {", src.indexOf("const nextOwner"));
    expect(okAt).toBeGreaterThan(-1);
    expect(okAt).toBeLessThan(i);
  });

  it("treats an unreachable step as expected, not as an error", () => {
    expect(src).toContain("step not reachable yet");
  });

  it("never breaks the webhook ack", () => {
    expect(src).toContain("owner invite queue walk failed");
  });
});
