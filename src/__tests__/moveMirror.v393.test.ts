// BF_SERVER_MOVE_MIRROR_v393
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shouldMirrorToPgi } from "../services/biDocMirror.js";

const route = readFileSync(path.join(process.cwd(), "src/routes/documents.ts"), "utf8");
const move = route.slice(route.indexOf('router.post("/:id/category"'), route.indexOf('router.post("/:id/accept"'));

describe("Move to… copies the document to BI", () => {
  it("mirrors after a move that changed the category", () => {
    expect(move).toContain("if (result.changed) {");
    expect(move).toContain("mirrorDocToBiAsync({");
    expect(move).toContain("documentType: category,");
    expect(move).toContain("bfDocumentId: toStringSafe(req.params.id),");
  });
  it("the mirror still decides which categories BI needs", () => {
    expect(shouldMirrorToPgi("A/R")).toBe(true);
    expect(shouldMirrorToPgi("PnL – Interim financials")).toBe(true);
    expect(shouldMirrorToPgi("6 months business banking statements")).toBe(false);
  });
  it("a failed lookup never fails the move", () => {
    expect(move).toContain('console.warn("[documents] move mirror lookup failed"');
    expect(move.indexOf("return ok(res, result);")).toBeGreaterThan(move.indexOf("mirrorDocToBiAsync({"));
  });
});
