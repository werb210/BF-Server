// BF_SERVER_APPLICATION_BY_ID_v441
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/applications.ts"), "utf8");

describe("v441 GET /api/applications/:id returns the application", () => {
  it("no longer echoes the id back as the whole payload", () => {
    expect(src).not.toContain('res.json({ status: "ok", data: { id: req.params.id } })');
  });

  it("uses the repo helper this file already imports", () => {
    expect(src).toContain("await findApplicationById(id)");
    expect(src).toContain('import { findApplicationById }');
  });

  it("adds no second database client", () => {
    expect(src).not.toContain('import { pool }');
  });

  it("404s a missing application instead of returning an empty 200", () => {
    expect(src).toContain("status(404)");
    expect(src).toContain('"not_found"');
  });

  it("answers both shapes, so existing callers keep working", () => {
    expect(src).toContain("data: application, ...application");
  });
});
