import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// BF_SERVER_CLOSING_COST_COMPANION_NAME_v1 - guards that the submit handler propagates the
// promoted business name onto closing-cost companion children still named with a
// placeholder ("Untitled Application" / draft), so the add-on stops showing "Untitled".
const src = readFileSync(
  fileURLToPath(new URL("../routes/client/v1Applications.ts", import.meta.url)),
  "utf-8",
);

describe("closing-cost companion name propagation", () => {
  it("updates companion children on submit", () => {
    expect(src).toContain("BF_SERVER_CLOSING_COST_COMPANION_NAME_v1");
    expect(src).toContain("SET name = $2, updated_at = NOW()");
    expect(src).toContain("closing_cost_companion");
  });
  it("only overwrites placeholder names", () => {
    expect(src).toContain("name = 'Untitled Application'");
    expect(src).toContain("if (wizardBusinessName)");
  });
});
