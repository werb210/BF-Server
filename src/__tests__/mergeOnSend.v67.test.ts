// BF_SERVER_MERGE_ON_SEND_v67 - renderMergeFields shipped in v65 and nothing
// called it, so {{contact.first_name}} went to clients as literal text.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { hasMergeFields, renderMergeFields } from "../services/mergeFields.js";

const ROUTE = fs.readFileSync("src/routes/communications.ts", "utf8");

describe("the cheap pre-check", () => {
  it("spots a token", () => {
    expect(hasMergeFields("Hi {{contact.first_name}}")).toBe(true);
  });

  it("ignores ordinary text, so no lookup is paid for", () => {
    expect(hasMergeFields("Hi Todd, your docs are ready")).toBe(false);
    expect(hasMergeFields("")).toBe(false);
  });

  it("is not fooled by a lone brace", () => {
    expect(hasMergeFields("cost {approx} 5k")).toBe(false);
  });
});

describe("SMS send resolves before Twilio", () => {
  it("checks for tokens first", () => {
    expect(ROUTE).toContain("hasMergeFields(String(body))");
  });

  it("looks the contact up by the id the composer already sends", () => {
    expect(ROUTE).toContain("FROM contacts c");
    expect(ROUTE).toContain("LEFT JOIN companies co");
  });

  it("resolves before the body is used", () => {
    const render = ROUTE.indexOf("body = renderMergeFields(");
    const twilio = ROUTE.indexOf("accountSid", render);
    expect(render).toBeGreaterThan(-1);
    expect(twilio).toBeGreaterThan(render);
  });

  it("never lets a merge failure block the send", () => {
    expect(ROUTE).toContain('console.warn("[sms] merge-field render failed"');
  });
});

describe("what the client actually receives", () => {
  const ctx = {
    contact: { name: "Jordan Lee", first_name: null, email: null, phone: null },
    company: { name: "Lee Haulage" },
  };

  it("fills the name", () => {
    expect(renderMergeFields("Hi {{contact.first_name}}, your docs are ready.", ctx))
      .toBe("Hi Jordan, your docs are ready.");
  });

  it("leaves an unresolvable token visible rather than sending a hole", () => {
    // "Hi ," reaching a client is worse than a visible token, because nobody
    // notices it in the sent log.
    expect(renderMergeFields("Call {{user.phone}} to confirm.", ctx))
      .toBe("Call {{user.phone}} to confirm.");
  });
});
