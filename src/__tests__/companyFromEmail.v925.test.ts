// BF_SERVER_v925_COMPANY_FROM_EMAIL - naming and domain rules.
import { describe, expect, it } from "vitest";
import { companyNameFromDomain, emailDomain } from "../crm/companyFromEmail.js";

describe("company from email domain", () => {
  it("uses work domains only", () => {
    expect(emailDomain("kathrina.pielago@signnow.com")).toBe("signnow.com");
    expect(emailDomain("Kyle@FirstNational.ca ")).toBe("firstnational.ca");
    expect(emailDomain("someone@gmail.com")).toBeNull();
    expect(emailDomain("someone@shaw.ca")).toBeNull();
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("x@example.com")).toBeNull();
  });
  it("names the company from the domain", () => {
    expect(companyNameFromDomain("signnow.com")).toBe("Signnow");
    expect(companyNameFromDomain("allen-capital.co.uk")).toBe("Allen Capital");
    expect(companyNameFromDomain("firstnational.ca")).toBe("Firstnational");
    expect(companyNameFromDomain("mail.versapay.com".replace(/^mail\./, ""))).toBe("Versapay");
  });
});
