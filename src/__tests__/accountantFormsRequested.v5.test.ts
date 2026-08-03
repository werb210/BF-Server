// BF_SERVER_ACCOUNTANT_FORMS_REQUESTED_v5
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const route = readFileSync(path.join(process.cwd(), "src/routes/accountant.ts"), "utf8");

describe("accountant forms are the requested ones", () => {
  it("never returns the whole allow-list as the form set", () => {
    // The allow-list is a ceiling, not the answer. Returning it verbatim showed
    // an accountant six forms when one bank statement was asked for.
    expect(route).not.toContain("forms: ACCOUNTANT_FORM_DOC_TYPES,");
    expect(route).toContain("forms: requestedForms,");
  });

  it("derives forms from what the application requires", () => {
    expect(route).toContain("const requestedForms = (outstanding.required ?? [])");
    expect(route).toContain("isAccountantForm(d)");
  });

  it("accepts more than one file per upload", () => {
    expect(route).not.toContain('upload.single("file")');
    expect(route).toContain('upload.array("files", 20)');
  });
});
