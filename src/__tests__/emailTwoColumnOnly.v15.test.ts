// BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15
import { describe, expect, it } from "vitest";
import { renderBrandedEmail } from "../services/emailTemplateRender.js";

const base = {
  headline: "Left headline", heroUrl: "https://x/left.png", heroLink: "https://left",
  body: "Left body", ctaLabel: "Left button", ctaUrl: "https://leftcta",
  image2Url: "https://x/banner.png", image2Link: "https://banner",
};

describe("two-column email", () => {
  it("never renders the old full-width image, even when a value is present", () => {
    const html = renderBrandedEmail({ ...base, headline2: "Right headline", body2: "Right body" });
    expect(html).not.toContain("banner.png");
  });

  it("drops it from single-column emails too", () => {
    expect(renderBrandedEmail(base)).not.toContain("banner.png");
  });

  it("puts headline, image, body then button in each column, in that order", () => {
    const html = renderBrandedEmail({
      ...base,
      headline2: "Right headline", body2: "Right body",
      rightImageUrl: "https://x/right.png", rightImageLink: "https://right",
      cta2Label: "Right button", cta2Url: "https://rightcta",
    });
    const left = html.indexOf("Left headline");
    const leftImg = html.indexOf("left.png");
    const leftBody = html.indexOf("Left body");
    const leftCta = html.indexOf("Left button");
    expect(left).toBeLessThan(leftImg);
    expect(leftImg).toBeLessThan(leftBody);
    expect(leftBody).toBeLessThan(leftCta);

    const right = html.indexOf("Right headline");
    const rightImg = html.indexOf("right.png");
    const rightBody = html.indexOf("Right body");
    const rightCta = html.indexOf("Right button");
    expect(right).toBeLessThan(rightImg);
    expect(rightImg).toBeLessThan(rightBody);
    expect(rightBody).toBeLessThan(rightCta);
    // Left column comes before right.
    expect(leftCta).toBeLessThan(right);
  });

  it("a right-hand image alone is enough to make it two columns", () => {
    const html = renderBrandedEmail({ ...base, rightImageUrl: "https://x/right.png" });
    expect(html).toContain("right.png");
    expect(html).toContain("email-column");
  });

  it("stays single column when nothing on the right is filled", () => {
    expect(renderBrandedEmail(base)).not.toContain("email-column");
  });
});
