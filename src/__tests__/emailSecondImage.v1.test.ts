// BF_SERVER_STALE_EMAIL_IMAGE_TESTS_v16
// This file used to pin BF_EMAIL_SECOND_IMAGE_v1, which rendered a standalone
// full-width picture (image2Url) BELOW the two-column frame. That behaviour was
// deliberately removed by BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - the stray banner
// under both columns was the excavator photo. The assertions are rewritten to the
// current intent rather than reverting the fix.
import { describe, expect, it } from "vitest";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

const IN_COLUMN = 'alt="" width="264"';
const FULL_WIDTH = 'alt="" width="544"';

const base: BrandedEmailFields = {
  headline: "Finance", heroUrl: "", heroLink: "",
  body: "Finance details", ctaLabel: "Apply", ctaUrl: "https://example.com/apply",
  image2Url: "https://example.com/standalone.png", image2Link: "",
};

describe("email images after BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15", () => {
  it("never renders image2Url below a two-column frame", () => {
    const html = renderBrandedEmail({ ...base, headline2: "Insurance", body2: "Coverage details" });
    expect(html.match(/<td class="email-column" width="264"/g)).toHaveLength(2);
    expect(html).not.toContain("https://example.com/standalone.png");
    expect(html).not.toContain(FULL_WIDTH);
  });

  it("does not borrow image2Url for the right column", () => {
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
    expect(html).not.toContain(FULL_WIDTH);
  });

  it("renders only the right-column picture when both controls are filled", () => {
    const html = renderBrandedEmail({
      ...base, headline2: "Insurance", body2: "Coverage details",
      rightImageUrl: "https://example.com/right.png", rightImageLink: "",
    });
    expect(html).toContain("https://example.com/right.png");
    expect(html).not.toContain("https://example.com/standalone.png");
    expect(html).toContain(IN_COLUMN);
    expect(html).not.toContain(FULL_WIDTH);
  });

  it("drops image2Url from single-column output too", () => {
    const html = renderBrandedEmail(base);
    expect(html).not.toContain("email-column");
    expect(html).not.toContain("https://example.com/standalone.png");
  });
});
