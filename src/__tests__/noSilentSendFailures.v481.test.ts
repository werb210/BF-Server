// BF_SERVER_BLOCK_v481_NO_SILENT_SEND_FAILURES
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

describe("v481 send-path failures are reported", () => {
  it("lender selection saves stop the send when an insert fails (both routes)", () => {
    const src = read("../routes/submissionOrchestration.ts");
    expect(src.match(/lender_selection_save_failed/g)?.length).toBe(2);
    expect(src).not.toMatch(/application_lender_selections[\s\S]{0,400}lenderIds\[i\], i\]\)\.catch\(\(\) => \{\}\)/);
  });
  it("additional-steps SMS only reports sent when Twilio accepted it", () => {
    const src = read("../modules/applications/applications.routes.ts");
    expect(src).toContain("[applications] additional-steps SMS failed");
    expect(src).not.toContain("Please log in to complete them: ${url}` }).catch(() => {});");
    expect(src).toContain("[applications] rejection notice to client failed");
  });
  it("owner invite queue and SBA envelope writes log when they fail", () => {
    expect(read("../signnow/embeddedSigningSession.ts")).toContain("owner invite queue NOT saved");
    expect(read("../signnow/sba/sbaSigning.ts")).toContain("envelope record NOT saved");
  });
});
