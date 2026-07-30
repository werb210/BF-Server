import { describe, expect, it } from "vitest";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

const fields: BrandedEmailFields = {
  headline: "Finance", heroUrl: "https://example.com/finance.png", heroLink: "",
  body: "Finance details", ctaLabel: "", ctaUrl: "",
  image2Url: "https://example.com/insurance.png", image2Link: "",
};

describe("BF_EMAIL_TWO_COLUMN_v1", () => {
  it("preserves the original markup when no second-column copy is supplied", () => {
    const html = renderBrandedEmail(fields);
    expect(html).not.toContain("email-column");
    expect(html).not.toContain("@media only screen");
  });

  it("renders two Outlook-safe 264px cells and a responsive stacking rule", () => {
    const html = renderBrandedEmail({ ...fields, headline2: "Insurance", body2: "Coverage details" });
    expect(html.match(/<td class=\"email-column\" width=\"264\"/g)).toHaveLength(2);
    expect(264 + 16 + 264).toBe(544);
    expect(html).toContain("@media only screen and (max-width:620px)");
    expect(html).toContain("Insurance");
    expect(html).toContain("Coverage details");
  });

  it("escapes both pieces of second-column copy", () => {
    const html = renderBrandedEmail({ ...fields, headline2: "Insurance <plans>", body2: "Terms & <conditions>" });
    expect(html).toContain("Insurance &lt;plans&gt;");
    expect(html).toContain("Terms &amp; &lt;conditions&gt;");
    expect(html).not.toContain("Insurance <plans>");
    expect(html).not.toContain("Terms & <conditions>");
  });
});
