// BF_SERVER_TODO_PROMPTS_v635 (shipped as BF-Server v638)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sbaFormsMissing } from "../services/applicantActions.js";

describe("SBA forms outstanding", () => {
  it("needs the 1919 and a 413 per owner", () => {
    expect(sbaFormsMissing([1, 2], ["sba_form_1919", "sba_form_413"])).toEqual(["sba_form_413_owner_2"]);
    expect(sbaFormsMissing([1], ["sba_form_1919", "sba_form_413"])).toEqual([]);
  });
});

describe("PGI and SBA prompts leave the chat for the to-do list", () => {
  it("action center adds them; the client thread leaves them out", () => {
    const actions = readFileSync("src/services/applicantActions.ts", "utf8");
    expect(actions).toContain("if (pgiUrl && (await termSheetSigned(applicationId)))");
    expect(actions).toContain('label: "SBA forms", action: "sba_forms"');
    const thread = readFileSync("src/routes/client/index.ts", "utf8");
    expect(thread).toContain('r.cta_label !== "Complete PGI Application" && r.cta_action !== "sba_forms"');
  });
});
