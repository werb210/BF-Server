import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTANT_ALWAYS_AVAILABLE,
  ACCOUNTANT_DOC_CATEGORIES,
  isAccountantVisible,
  normaliseCategory,
} from "../routes/accountant.js";

const route = readFileSync(fileURLToPath(new URL("../routes/accountant.ts", import.meta.url)), "utf-8");
const contact = readFileSync(
  fileURLToPath(new URL("../modules/website/contact.controller.ts", import.meta.url)),
  "utf-8",
);

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 routes", () => {
  it("serves the two endpoints the client calls on sign-in", () => {
    expect(route).toContain('\"/me\",');
    expect(route).toContain('\"/applications/:id\",');
  });

  it("scopes both to invitations for the contact on the token", () => {
    expect(route).toContain("AND ai.contact_id::text = ($2)::text");
    expect(route).toContain("WHERE ai.contact_id::text = ($1)::text");
  });
});

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 permissions", () => {
  it("denies by default rather than allowing by default", () => {
    expect(isAccountantVisible("something nobody has thought of")).toBe(false);
    expect(isAccountantVisible("Cheque images")).toBe(false);
  });

  it("allows the categories on the list", () => {
    expect(isAccountantVisible("6 months business banking statements")).toBe(true);
    expect(isAccountantVisible("3 years business tax returns")).toBe(true);
    expect(isAccountantVisible("A/R")).toBe(true);
  });

  it("matches the interim statements despite the dash the database stores", () => {
    expect(isAccountantVisible("PnL \u2014 Interim financials")).toBe(true);
    expect(isAccountantVisible("Balance Sheet \u2013 Interim financials")).toBe(true);
  });

  it("keeps applicant-only documents away from the accountant", () => {
    expect(isAccountantVisible("Personal net worth statement")).toBe(false);
    expect(isAccountantVisible("2 pieces of Government Issued ID")).toBe(false);
    expect(isAccountantVisible("Purchase Order or Invoice of Equipment to finance")).toBe(false);
  });

  it("rejects empty and non-string categories", () => {
    expect(isAccountantVisible("")).toBe(false);
    expect(isAccountantVisible(null)).toBe(false);
  });

  it("offers the three categories no lender product lists", () => {
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("2 years personal tax returns (T1 generals)");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("Lease agreement");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("Real estate collateral");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).not.toContain("Other");
  });

  it("has no duplicate categories", () => {
    const keys = ACCOUNTANT_DOC_CATEGORIES.map(normaliseCategory);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 contact autoresponder", () => {
  it("sends the acknowledgement down the transactional path", () => {
    expect(contact).toContain("await sendTransactional({");
    expect(contact).not.toContain("sendOne");
  });
});
