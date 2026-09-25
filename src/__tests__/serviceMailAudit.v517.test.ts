// BF_SERVER_BLOCK_v517_SERVICE_MAIL_AUDIT
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/serviceBridge.ts", import.meta.url)), "utf-8");

describe("v517 service mail audit", () => {
  it("logs success and failure with the mailbox used, and returns it", () => {
    expect(src).toContain('"[service-mail] accepted_by_microsoft"');
    expect(src).toContain('"[service-mail] send_failed"');
    expect(src).toContain("res.json({ ok: true, messageId: result.messageId ?? null, sentAs });");
  });
  it("never logs the full recipient address", () => {
    expect(src).toContain('const toDomain = to.includes("@") ? to.split("@").pop() : "unknown";');
    expect(src).not.toContain("{ silo, sentAs, to,");
  });
});
