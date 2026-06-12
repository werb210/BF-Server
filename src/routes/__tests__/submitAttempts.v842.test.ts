import { describe, expect, it } from "vitest";
import { buildSubmitAttemptWrite } from "../client/submitAttempts.js";

describe("BF_SERVER_BLOCK_v842 — buildSubmitAttemptWrite", () => {
  it("upserts by application_token when present", () => {
    const { sql, params } = buildSubmitAttemptWrite({
      applicationToken: "tok-1", phone: "+1587", businessName: "Acme", status: "attempted",
    });
    expect(sql).toContain("INSERT INTO submit_attempts");
    expect(sql).toContain("ON CONFLICT (application_token)");
    expect(params[0]).toBe("tok-1");
    expect(params[4]).toBe("attempted");
  });
  it("keeps a 'completed' row sticky in the conflict clause", () => {
    const { sql } = buildSubmitAttemptWrite({ applicationToken: "t", status: "attempted" });
    expect(sql).toContain("WHEN submit_attempts.status = 'completed'");
  });
  it("plain INSERT (no ON CONFLICT) when there is no token", () => {
    const { sql, params } = buildSubmitAttemptWrite({ phone: "+1587", status: "completed" });
    expect(sql).toContain("INSERT INTO submit_attempts");
    expect(sql).not.toContain("ON CONFLICT");
    expect(params[3]).toBe("completed");
  });
  it("coerces unknown status to 'attempted' and defaults silo to BF", () => {
    const { params } = buildSubmitAttemptWrite({ applicationToken: "t", status: "bogus" });
    expect(params[4]).toBe("attempted");
    expect(params[7]).toBe("BF");
  });
  it("truncates oversized fields and nulls non-strings", () => {
    const { params } = buildSubmitAttemptWrite({
      applicationToken: "t", phone: "x".repeat(100), email: 123 as any, error: "e".repeat(5000),
    });
    expect((params[1] as string).length).toBe(32);
    expect(params[2]).toBeNull();
    expect((params[5] as string).length).toBe(1000);
  });
});
