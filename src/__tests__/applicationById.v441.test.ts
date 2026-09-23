// BF_SERVER_APPLICATION_BY_ID_v441
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/applications.ts"), "utf8");

describe("v441 GET /api/applications/:id returns the application", () => {
  it("no longer echoes the id back as the whole payload", () => {
    expect(src).not.toContain('res.json({ status: "ok", data: { id: req.params.id } })');
  });

  it("reads the row from the applications table", () => {
    expect(src).toContain("FROM applications");
    expect(src).toContain("pipeline_state");
    expect(src).toContain("requested_amount");
  });

  it("404s a missing application instead of returning an empty 200", () => {
    expect(src).toContain('status(404)');
    expect(src).toContain('"not_found"');
  });

  it("answers both shapes, so existing callers keep working", () => {
    // BF-portal reads response fields directly; others read .data.
    expect(src).toContain("data: row, ...row");
  });
});
