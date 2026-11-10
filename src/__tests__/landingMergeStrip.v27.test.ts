// BF_SERVER_LANDING_MERGE_STRIP_v27
import { describe, expect, it } from "vitest";
import { stripMergeFields, tidyRemovedMerge } from "../services/landingPage.service.js";

describe("landing page merge token handling", () => {
  it("drops a leading salutation and recapitalises", () => {
    expect(stripMergeFields("<h1>{{first_name}}, your file may fit lenders</h1>"))
      .toBe("<h1>Your file may fit lenders</h1>");
  });

  it("handles a token mid-sentence without leaving a double space", () => {
    expect(stripMergeFields("<p>Hi {{first_name}} and welcome</p>"))
      .toBe("<p>Hi and welcome</p>");
  });

  it("removes every supported token, not just first_name", () => {
    const out = stripMergeFields("<p>{{name}} {{company}} {{email}}</p>");
    expect(out).not.toMatch(/\{\{/);
  });

  it("leaves html with no tokens untouched", () => {
    const html = "<p>No tokens here at all.</p>";
    expect(stripMergeFields(html)).toBe(html);
  });

  it("never renders a placeholder name on a public page", () => {
    expect(stripMergeFields("<h1>{{first_name}}, hello</h1>")).not.toContain("there");
  });

  // BF_SERVER_v933_LANDING_MERGE_DEFAULTS
  it("does not leave a space before the comma after a greeting", () => {
    expect(stripMergeFields("<p>Hi {{first_name}},</p>")).toBe("<p>Hi,</p>");
    expect(tidyRemovedMerge("<p>Hi ,</p><p>Thanks !</p>")).toBe("<p>Hi,</p><p>Thanks!</p>");
    expect(tidyRemovedMerge("<p>Rates from 8.99% , terms</p>")).toBe("<p>Rates from 8.99% , terms</p>");
  });
});
