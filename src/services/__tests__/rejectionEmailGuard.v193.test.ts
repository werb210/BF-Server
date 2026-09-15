// BF_SERVER_REJECTION_EMAIL_GUARD_v193
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/services/rejectionNotice.ts", "utf-8");
const guarded = src.slice(src.indexOf("BF_SERVER_REJECTION_EMAIL_GUARD_v193"));

describe("rejection email attempt guard", () => {
  it("still reserves the attempt up front so concurrent rejects cannot double-send", () => {
    expect(src).toMatch(/UPDATE applications SET rejection_email_sent_at = NOW\(\)[\s\S]*?rejection_email_sent_at IS NULL/);
  });

  it("releases the reservation when there is no recipient", () => {
    expect(guarded).toMatch(/releaseAttempt\("no_client_email"\)[\s\S]{0,120}return \{ sent: false, error: "no_client_email" \}/);
  });

  it("releases the reservation when no reasons were recorded", () => {
    expect(guarded).toMatch(/releaseAttempt\("no_reasons"\)[\s\S]{0,120}return \{ sent: false, error: "no_reasons" \}/);
  });

  it("never releases on already_sent - that one is a real prior send", () => {
    const block = src.slice(src.indexOf("already_sent") - 200, src.indexOf("already_sent") + 120);
    expect(block).not.toContain("releaseAttempt");
  });

  it("clearing the stamp can never throw and abort the reject", () => {
    const fn = guarded.slice(guarded.indexOf("async function releaseAttempt"));
    expect(fn.slice(0, fn.indexOf("}\n"))).toContain(".catch(() => undefined)");
  });
});
