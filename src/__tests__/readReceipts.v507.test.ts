// BF_SERVER_BLOCK_v507_READ_RECEIPTS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const client = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
const comms = readFileSync(fileURLToPath(new URL("../routes/communications.ts", import.meta.url)), "utf-8");

describe("v507 read receipts", () => {
  it("client message list returns read_at", () => {
    expect(client).toContain("created_at, read_at /* BF_SERVER_BLOCK_v507 */");
    expect(client).toContain("read_at: r.read_at ?? null,");
  });
  it("conversation detail returns readAt", () => {
    expect(comms).toContain("media_duration_seconds, created_at, read_at\n");
    expect(comms).toContain("readAt: m.read_at ?? null,");
  });
});
