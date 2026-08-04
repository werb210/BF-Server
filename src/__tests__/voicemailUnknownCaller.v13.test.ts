// BF_SERVER_VM_UNKNOWN_CALLER_v13
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../modules/voice/voicemailEnrich.service.ts", import.meta.url)),
  "utf-8",
);

describe("voicemail unknown caller", () => {
  it("does not name a contact after their phone number", () => {
    expect(src).not.toContain('first_name: from || "Unknown"');
    expect(src).toContain('first_name: "Unknown caller"');
  });

  it("still records the number where it belongs", () => {
    const create = src.slice(src.indexOf("const created = await createContact"));
    expect(create).toContain("phone: from || null");
  });

  it("still prefers an existing contact over creating one", () => {
    // The lookup must run first, or every voicemail mints a duplicate.
    expect(src.indexOf("SELECT id FROM contacts")).toBeLessThan(
      src.indexOf("const created = await createContact"),
    );
  });
});
