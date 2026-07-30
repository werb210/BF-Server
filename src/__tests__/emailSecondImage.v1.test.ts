import { describe, expect, it } from "vitest";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

const STANDALONE = 'alt="" width="544"';
const IN_COLUMN = 'alt="" width="264"';

const base: BrandedEmailFields = {
  headline: "Finance", heroUrl: "", heroLink: "",
  body: "Finance details", ctaLabel: "Apply", ctaUrl: "https://example.com/apply",
  image2Url: "https://example.com/standalone.png", image2Link: "",
};

describe("BF_EMAIL_SECOND_IMAGE_v1", () => {
  it("keeps the standalone picture when a second column is present", () => {
    const html = renderBrandedEmail({ ...base, headline2: "Insurance", body2: "Coverage details" });
    expect(html.match(/<td class="email-column" width="264"/g)).toHaveLength(2);
    expect(html).toContain("https://example.com/standalone.png");
    expect(html).toContain(STANDALONE);
  });

  it("does not borrow the standalone picture for the right column", () => {
    const html = renderBrandedEmail({ ...base, headline2: "Insurance", body2: "Coverage details" });
    expect(html).not.toContain(IN_COLUMN);
  });

  it("uses the right-column picture only in the right column", () => {
    const html = renderBrandedEmail({
      ...base, image2Url: "", headline2: "Insurance", body2: "Coverage details",
      rightImageUrl: "https://example.com/right.png", rightImageLink: "https://example.com/right",
    });
    expect(html).toContain("https://example.com/right.png");
    expect(html).toContain(IN_COLUMN);
    expect(html).not.toContain(STANDALONE);
  });

  it("renders both pictures when both controls are filled", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Insurance", body2: "Coverage details",
      rightImageUrl: "https://example.com/right.png", rightImageLink: "",
    });
    expect(html).toContain("https://example.com/right.png");
    expect(html).toContain("https://example.com/standalone.png");
    expect(html).toContain(IN_COLUMN);
    expect(html).toContain(STANDALONE);
  });

  it("leaves single-column output unchanged", () => {
    const html = renderBrandedEmail(base);
    expect(html).not.toContain("email-column");
    expect(html).toContain("https://example.com/standalone.png");
  });
});
