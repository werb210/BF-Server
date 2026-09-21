// BF_SERVER_MOVE_WITHDRAW_v395
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withdrawDocFromBiAsync } from "../services/biDocMirror.js";

const route = readFileSync(path.join(process.cwd(), "src/routes/documents.ts"), "utf8");

afterEach(() => vi.restoreAllMocks());

describe("moving a document out of a PGI category retires BI's copy", () => {
  it("the move route asks for it", () => {
    expect(route).toContain("withdrawDocFromBiAsync(String(result.applicationId), toStringSafe(req.params.id), result.from ?? null, category);");
  });
  it("only fires when the document LEFT a PGI category for a non-PGI one", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    withdrawDocFromBiAsync("app", "doc", "Other", "Lease agreement (if applicable)"); // never in BI
    withdrawDocFromBiAsync("app", "doc", "A/R", "A/P");                                // still in BI: re-mirrored instead
    withdrawDocFromBiAsync("app", "doc", "Other", "A/R");                              // moving in, not out
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
