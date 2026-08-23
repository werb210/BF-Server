// BF_SERVER_MEETING_LINK_v70 - {{meeting_link}} was offered by the Templates
// UI from v693 and resolved nowhere, so it sent literal braces to recipients.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { MERGE_FIELD_NAMES } from "../services/mergeFields.js";

const O365 = fs.readFileSync("src/routes/o365.ts", "utf8");
const COMMS = fs.readFileSync("src/routes/communications.ts", "utf8");

describe("the token now resolves", () => {
  it("is in the email context", () => {
    expect(O365).toContain("meeting_link:");
    expect(O365).toContain("mergeCtx.meeting_link =");
  });

  it("is in the SMS and messenger context", () => {
    expect(COMMS).toContain("ctx.meeting_link =");
  });

  it("reads the sender's own booking link", () => {
    expect(O365).toContain("SELECT booking_url FROM user_settings");
    expect(COMMS).toContain("SELECT booking_url FROM user_settings");
  });
});

describe("the shape suits the channel", () => {
  it("email gets a button", () => {
    expect(O365).toContain("Book a meeting</a>");
  });

  it("on the brand navy, not the old indigo", () => {
    expect(O365).toContain("background:#0B1F3A");
    expect(O365).not.toContain("background:#1E3A8A;color:#ffffff;text-decoration:none");
  });

  it("SMS gets the bare url, with no markup", () => {
    const block = COMMS.slice(COMMS.indexOf("BF_SERVER_MEETING_LINK_v70"));
    expect(block).not.toContain("<a href");
  });
});

describe("it degrades quietly", () => {
  it("resolves to empty rather than leaving braces when unset", () => {
    expect(O365).toContain('meeting_link: ""');
    expect(COMMS).toContain('meeting_link: ""');
  });
});

describe("the catalogue can offer it honestly now", () => {
  it("is in the live set", () => {
    expect(MERGE_FIELD_NAMES).toContain("meeting_link");
  });
});
