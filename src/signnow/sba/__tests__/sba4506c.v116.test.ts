// BF_SERVER_SBA_4506C_v116
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEMPLATE_EDITIONS } from "../templates.js";
import { SBA_4506C_FIELDS } from "../fieldMaps.js";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
const maps = readFileSync(resolve(__dirname, "..", "fieldMaps.ts"), "utf-8");

describe("registration", () => {
  it("4506-C is a known form key", () => { expect(TEMPLATE_EDITIONS).toHaveProperty("form_4506c"); });
  it("the edition is flagged unconfirmed until the template is read", () => { expect(TEMPLATE_EDITIONS.form_4506c).toContain("UNCONFIRMED"); });
  it("the blob name is overridable by env, like the others", () => {
    const t = readFileSync(resolve(__dirname, "..", "templates.ts"), "utf-8");
    expect(t).toContain("process.env.SBA_4506C_BLOB");
  });
});

describe("it refuses rather than guessing", () => {
  it("the field map is empty until read from the real PDF", () => { expect(Object.keys(SBA_4506C_FIELDS).length).toBe(0); });
  it("the builder returns null while unmapped", () => {
    expect(builder).toContain("if (mapped === 0)"); expect(builder).toContain("sba_4506c_not_mapped");
  });
  it("a missing template is logged, not thrown", () => { expect(builder).toContain("sba_4506c_template_missing"); });
  it("the instructions to finish it sit next to the empty map", () => {
    expect(maps).toContain("pypdf"); expect(maps).toContain("EMPTY ON PURPOSE");
  });
});

describe("why it matters", () => {
  it("records that a blank authorization is worse than none", () => { expect(builder).toContain("looks signed"); });
});
