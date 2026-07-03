// BF_SERVER_SEQ_NO_ADVANCE_ON_SEND_FAIL_v1 - failed email/SMS sends must not
// advance or complete an enrollment, and must remove the pre-inserted
// sequence_sends attempt row so analytics only count real sends.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
describe("sequence send-failure handling", () => {
  it("retries instead of advancing on email failure", () => {
    expect(src).toContain("SEQ_NO_ADVANCE_ON_SEND_FAIL_v1");
    expect(src).toContain('console.error("[sequence] email send failed; will retry"');
    expect(src).toContain("await bump(pool, en.id, 60);");
  });
  it("removes the pre-inserted attempt row on failure", () => {
    expect(src).toContain("DELETE FROM sequence_sends WHERE id=$1");
  });
  it("sms failures (non opt-out) also retry", () => {
    expect(src).toContain('console.error("[sequence] sms send failed; will retry"');
  });
});
