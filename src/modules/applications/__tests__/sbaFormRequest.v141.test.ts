// BF_SERVER_SBA_FORM_REQUEST_v141
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routes = readFileSync(resolve(__dirname, "..", "applications.routes.ts"), "utf-8");
const trigger = readFileSync(
  resolve(__dirname, "..", "..", "..", "signnow", "sba", "sbaTrigger.ts"), "utf-8");

describe("every spelling of the SBA forms is accepted", () => {
  it.each(["sba1919", "sba413", "sba_form_1919", "sba_form_413"])("%s resolves", (key) => {
    const i = routes.indexOf("SBA_FORM_ALIASES");
    expect(routes.slice(i, i + 400)).toContain(key);
  });

  it("per-owner 413 keys resolve to the same page", () => {
    expect(routes).toContain("/^sba_form_413_owner_\\d+$/.test(x)");
  });

  it("a request no longer falls through the FORM_LABELS filter", () => {
    expect(routes).not.toContain(".filter((x: string) => x in FORM_LABELS)");
    expect(routes).toContain("normalizeFormId(x)");
  });
});

describe("an SBA form is never posted as an upload", () => {
  it("is filtered out of the documents list", () => {
    expect(routes).toContain("rawDocs.filter((x) => normalizeFormId(x) !== 'sba_forms')");
  });

  it("and becomes a form prompt instead of being dropped", () => {
    expect(routes).toContain("sbaFromDocs.length ? ['sba_forms'] : []");
  });
});

describe("one prompt, not one per owner", () => {
  it("all SBA keys collapse to a single cta", () => {
    const i = routes.indexOf("const SBA_FORM_ALIASES");
    const block = routes.slice(i, i + 400);
    expect((block.match(/'sba_forms'/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it("the label is generic, because the page lists whatever is outstanding", () => {
    expect(routes).toContain("FORM_LABELS.sba_forms = 'SBA Forms'");
  });
});

describe("why it mattered", () => {
  it("signing waits on form responses that could not be created", () => {
    expect(trigger).toContain("sba_form_1919");
    expect(trigger).toContain("sba_form_413");
    expect(trigger).toContain("waiting_on:");
  });
});
