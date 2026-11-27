// BF_SERVER_SILO_CORE_TAGS_v1
import { describe, expect, it } from "vitest";
import { coreTagsFor } from "../tags.js";

describe("coreTagsFor", () => {
  it("Keystone offers Lender and Broker only", () => {
    expect(coreTagsFor("ks").map((t) => t.slug)).toEqual(["lender", "broker"]);
  });
  it("BF keeps every shared tag", () => {
    expect(coreTagsFor("BF").map((t) => t.slug)).toContain("ar_credit_insurance");
  });
});
