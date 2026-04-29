// BF_PORTAL_REFRESH_AND_PARSE_v55_SERVER — guard against regressing back
// to res.status(204).end() which breaks the portal's apiFetch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "..", "portalLenders.ts"), "utf8");

describe("BF_PORTAL_REFRESH_AND_PARSE_v55_SERVER", () => {
  it("DELETE handler returns JSON, not bare 204", () => {
    expect(SRC).toContain('res.status(200).json({ ok: true, deleted: true, id })');
    expect(SRC).not.toContain("res.status(204).end()");
  });
});
