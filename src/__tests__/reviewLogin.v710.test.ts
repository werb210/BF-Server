// BF_SERVER_REVIEW_LOGIN_v710
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { isReviewPhone, reviewCodeMatches } from "../services/reviewLogin.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

describe("store-review sign-in", () => {
  afterEach(() => { delete process.env.REVIEW_LOGIN_PHONE; delete process.env.REVIEW_LOGIN_CODE; });
  it("is off unless both settings are present", () => {
    expect(isReviewPhone("+18255550199")).toBe(false);
    process.env.REVIEW_LOGIN_PHONE = "+18255550199";
    expect(isReviewPhone("+18255550199")).toBe(false);
  });
  it("matches the configured number and only its code", () => {
    process.env.REVIEW_LOGIN_PHONE = "+18255550199";
    process.env.REVIEW_LOGIN_CODE = "864213";
    expect(isReviewPhone("(825) 555-0199")).toBe(true);
    expect(isReviewPhone("+14035550101")).toBe(false);
    expect(reviewCodeMatches("+18255550199", "864213")).toBe(true);
    expect(reviewCodeMatches("+18255550199", "000000")).toBe(false);
    expect(reviewCodeMatches("+14035550101", "864213")).toBe(false);
  });
  it("the sign-in skips the text and skips Twilio's check only for that number", () => {
    const auth = read("../routes/auth.ts");
    expect(auth).toContain("if (isReviewPhone(phone)) {");
    expect(auth).toContain('? { status: reviewCodeMatches(phone, String(code)) ? "approved" : "denied" }');
  });
});
