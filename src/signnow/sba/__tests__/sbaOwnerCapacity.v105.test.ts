// BF_SERVER_SBA_OWNER_CAPACITY_v105
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (...p: string[]) => readFileSync(resolve(__dirname, ...p), "utf-8");
const trigger = R("..", "sbaTrigger.ts");
const builder = R("..", "sbaFormBuilder.ts");

describe("owner capacity", () => {
  it("never demands a 413 beyond the renderers the client registers", () => {
    expect(trigger).toContain("const OWNER_CAPACITY = 5;");
    expect(trigger).toContain("owners.filter((o) => o.index <= OWNER_CAPACITY)");
  });

  it("holds the file rather than quietly shipping a truncated 1919", () => {
    expect(trigger).toContain("SBA_OVERFLOW:");
    expect(trigger).toContain("sba_owner_capacity_exceeded");
  });

  it("the capacity here matches the form's own MAX_OWNERS", () => {
    const fieldMaps = R("..", "fieldMaps.ts");
    expect(fieldMaps).toContain("MAX_OWNERS: 5");
    expect(trigger).toContain("const OWNER_CAPACITY = 5;");
  });

  it("the builder logs when it drops an owner", () => {
    expect(builder).toContain("sba_1919_owners_truncated");
    expect(builder).toContain("owners.length > F19.MAX_OWNERS");
  });

  it("the client ceiling is still five", () => {
    // If a sixth renderer is ever added, OWNER_CAPACITY must move with it.
    expect(trigger).not.toContain("sba_form_413_owner_6");
  });
});
