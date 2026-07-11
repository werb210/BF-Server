import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("BF_SERVER_SENDMAIL_ITEMNOTFOUND_RETRY_v1", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/routes/o365.ts"),
    "utf8",
  );

  it("carries the sentinel", () => {
    expect(src).toContain("BF_SERVER_SENDMAIL_ITEMNOTFOUND_RETRY_v1");
  });

  it("retries the send without saveToSentItems on ErrorItemNotFound", () => {
    expect(src).toContain('firstDetail.includes("ErrorItemNotFound")');
    expect(src).toContain("saveToSentItems: false");
  });

  it("still surfaces a 502 when the retry also fails", () => {
    expect(src).toContain('error: "graph_send_failed"');
  });
});
