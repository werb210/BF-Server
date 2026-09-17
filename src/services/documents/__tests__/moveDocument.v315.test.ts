// BF_SERVER_MOVE_DOCUMENT_v315
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { canMoveDocuments, cleanCategory, moveDocument } from "../moveDocument.js";

describe("moving a document to another category", () => {
  it("only staff can move documents", () => {
    expect(canMoveDocuments("Admin")).toBe(true);
    expect(canMoveDocuments("Staff")).toBe(true);
    expect(canMoveDocuments("client")).toBe(false);
    expect(canMoveDocuments("lender")).toBe(false);
    expect(canMoveDocuments("")).toBe(false);
  });

  it("requires a category", () => {
    expect(cleanCategory("  6 months business banking statements ")).toBe("6 months business banking statements");
    expect(cleanCategory("")).toBeNull();
    expect(cleanCategory(42)).toBeNull();
  });

  it("moves category and document type together and clears the auto-moved marker", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("SELECT") ? { rows: [{ id: "d1", application_id: "a1", category: "A/R" }] } : { rows: [] });
    const r = await moveDocument(query as any, "d1", "6 months business banking statements", "u1");
    expect(r).toMatchObject({ ok: true, from: "A/R", to: "6 months business banking statements", changed: true });
    const update = String(query.mock.calls[1][0]);
    expect(update).toContain("document_type = $2");
    expect(update).toContain("category_before_retag = NULL");
  });

  it("reports a missing document and ignores a move to the same category", async () => {
    expect(await moveDocument((async () => ({ rows: [] })) as any, "x", "A/R", null)).toEqual({ ok: false, reason: "not_found" });
    const same = vi.fn(async () => ({ rows: [{ id: "d1", application_id: "a1", category: "A/R" }] }));
    expect((await moveDocument(same as any, "d1", "A/R", null)).changed).toBe(false);
    expect(same).toHaveBeenCalledTimes(1);
  });

  it("is routed", () => {
    expect(fs.readFileSync("src/routes/documents.ts", "utf8")).toContain('router.post("/:id/category", requireAuth');
  });
});
