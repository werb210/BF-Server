// BF_MINI_PORTAL_NOTES_v47 — pure-function tests for mention extraction.
import { describe, it, expect } from "vitest";
import { extractMentionTokens } from "../mentions.js";

describe("BF_MINI_PORTAL_NOTES_v47 extractMentionTokens", () => {
  it("finds simple @user mentions", () => {
    expect(extractMentionTokens("hi @alice please review")).toEqual(["alice"]);
  });
  it("finds multiple mentions, deduplicates, lowercases", () => {
    expect(extractMentionTokens("@Bob @bob @CAROL").sort()).toEqual(["bob", "carol"]);
  });
  it("ignores email addresses (no leading whitespace/paren)", () => {
    expect(extractMentionTokens("contact me at me@example.com")).toEqual([]);
  });
  it("handles dotted/hyphenated/underscored usernames", () => {
    expect(extractMentionTokens("ping @first.last and @some-user and @snake_case").sort()).toEqual(
      ["first.last", "snake_case", "some-user"]
    );
  });
  it("returns [] for empty body", () => {
    expect(extractMentionTokens("")).toEqual([]);
  });
  it("respects min length 2 / max length 40", () => {
    expect(extractMentionTokens("@a @ab")).toEqual(["ab"]);
    expect(extractMentionTokens("@" + "x".repeat(41))).toEqual([]);
  });
});
