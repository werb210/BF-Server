// BF_SERVER_BACKGROUND_UPLOAD_TAB_v310
import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("Documents tab background-upload flag", () => {
  it("the portal application response carries receivedInBackground for each document", () => {
    const portal = fs.readFileSync("src/routes/portal.ts", "utf8");
    expect(portal).toContain("COALESCE(received_in_background, false) AS received_in_background");
    expect(portal).toContain("receivedInBackground: Boolean(");
  });
});
