import { describe, expect, it } from "vitest";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

const base: BrandedEmailFields = {
  headline: "Left", heroUrl: "", heroLink: "", body: "Left copy",
  ctaLabel: "Apply now", ctaUrl: "https://example.com/apply",
  image2Url: "", image2Link: "",
};

describe("BF_EMAIL_SECOND_COLUMN_CTA_v1", () => {
  it("puts a button in each column when a second column exists", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Right", body2: "Right copy",
      cta2Label: "Talk to us", cta2Url: "https://example.com/talk",
    });
    expect(html).toContain("Apply now");
    expect(html).toContain("Talk to us");
    expect(html).toContain("https://example.com/talk");
  });

  it("renders each button exactly once", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Right", body2: "Right copy",
      cta2Label: "Talk to us", cta2Url: "https://example.com/talk",
    });
    expect(html.match(/Apply now/g)).toHaveLength(1);
    expect(html.match(/Talk to us/g)).toHaveLength(1);
  });

  it("leaves the right column buttonless when only the left has one", () => {
    const html = renderBrandedEmail({ ...base, headline2: "Right", body2: "Right copy" });
    expect(html).toContain("Apply now");
    expect(html.match(/Apply now/g)).toHaveLength(1);
  });

  it("needs both a label and a link before it renders anything", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Right", body2: "Right copy", cta2Label: "Talk to us", cta2Url: "",
    });
    expect(html).not.toContain("Talk to us");
  });

  it("leaves single-column emails exactly as they were", () => {
    const html = renderBrandedEmail(base);
    expect(html).not.toContain("email-column");
    expect(html).toContain("Apply now");
    expect(html.match(/Apply now/g)).toHaveLength(1);
  });

  it("sizes the column button for the column, not the frame", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Right", body2: "Right copy",
      cta2Label: "Talk to us", cta2Url: "https://example.com/talk",
    });
    expect(html).toContain("padding:12px 22px");
  });

  it("escapes a label containing markup", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Right", cta2Label: '<b>Go</b>', cta2Url: "https://example.com/x",
    });
    expect(html).toContain("&lt;b&gt;Go&lt;/b&gt;");
  });
});
