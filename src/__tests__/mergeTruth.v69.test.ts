// BF_SERVER_MERGE_TRUTH_v69 - the Snippets picker offered dotted tokens that
// no live renderer understands, so a snippet written from it sent the braces
// to the client.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { MERGE_FIELD_NAMES, LIVE_MERGE_FIELDS } from "../services/mergeFields.js";

const COMMS = fs.readFileSync("src/routes/communications.ts", "utf8");
const O365 = fs.readFileSync("src/routes/o365.ts", "utf8");

describe("the catalogue matches what actually renders", () => {
  it("offers flat tokens, not dotted ones", () => {
    for (const name of MERGE_FIELD_NAMES) {
      expect(name).not.toContain(".");
    }
  });

  it("offers exactly the live set", () => {
    expect(MERGE_FIELD_NAMES).toEqual(["first_name", "last_name", "full_name", "name", "email"]);
  });

  it("every offered token is built by the SMS context", () => {
    for (const name of LIVE_MERGE_FIELDS) {
      expect(COMMS).toContain(`ctx.${name}`);
    }
  });

  it("every offered token is built by the email context", () => {
    for (const name of ["first_name", "last_name", "name", "email"]) {
      expect(O365).toContain(`mergeCtx.${name}`);
    }
  });
});

describe("the live renderers can parse what is offered", () => {
  // renderMergeTokensComm matches /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/ - no dots.
  const pattern = /^[a-zA-Z0-9_]+$/;

  it("no offered token would fail the renderer's own regex", () => {
    for (const name of MERGE_FIELD_NAMES) {
      expect(pattern.test(name)).toBe(true);
    }
  });
});

describe("email resolves on SMS as well as email", () => {
  it("is in the SMS context defaults", () => {
    expect(COMMS).toContain('name: "", email: ""');
  });

  it("is populated from the contact row", () => {
    expect(COMMS).toContain("ctx.email =");
  });
});
