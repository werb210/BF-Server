import { describe, expect, it } from "vitest";
import { mergeSmsFields, renderMarketingSms } from "../services/marketingSms.js";

describe("marketing SMS merge fields", () => {
  const vars = { first_name: "Ada", name: "Ada Lovelace", email: "ada@example.com", company: "Boreal" };

  it("merges supported fields case-insensitively and removes missing values", () => {
    expect(mergeSmsFields("Hi {{ FIRST_NAME }}, {{company}} {{missing}}", vars))
      .toBe("Hi Ada, Boreal ");
  });

  it("renders merge fields, link, and CASL footer in order", () => {
    expect(renderMarketingSms({ body: "Hi {{first_name}}", vars, link: "https://example.test/r/1" }))
      .toBe("Hi Ada https://example.test/r/1 Reply STOP to opt out. Info: www.boreal.financial/sms");
  });

  it("still appends the CASL footer when no link is supplied", () => {
    expect(renderMarketingSms({ body: "Hi {{name}}", vars, link: null }))
      .toBe("Hi Ada Lovelace Reply STOP to opt out. Info: www.boreal.financial/sms");
  });
});
