// BF_SERVER_PASS_REASON_OPTIONAL_v222
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/modules/applications/applications.routes.ts", "utf-8");
const block = src.slice(src.indexOf("BF_SERVER_PASS_REASON_OPTIONAL_v222"));

describe("recording a lender pass", () => {
  it("no longer rejects an empty note outright", () => {
    // The portal modal labels the note optional; the server used to 400 on it.
    expect(src).not.toContain("if (!reason) throw new AppError('validation_error', 'A reason is required.', 400);");
  });

  it("accepts reason codes instead of free text", () => {
    expect(block).toContain("if (!reason && reasonCodes.length === 0)");
  });

  it("still refuses a pass with no why at all", () => {
    // Loosening this into "anything goes" would lose the decline reason that
    // the lender summary is built from.
    expect(block).toContain("Select at least one reason code, or write a note.");
    expect(block).toContain("400");
  });

  it("ignores blank entries in the codes array", () => {
    expect(block).toContain(".filter(Boolean)");
  });

  it("does not assume reasonCodes is an array", () => {
    expect(block).toContain("Array.isArray(req.body?.reasonCodes)");
  });
});
