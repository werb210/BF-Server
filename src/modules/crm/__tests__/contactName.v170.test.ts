import { describe, it, expect } from "vitest";
import { isPlaceholderName, resolveContactName } from "../contactName.js";

describe("BF_SERVER_PLACEHOLDER_NAME_v170", () => {
  it("recognises the wizard's draft name", () => {
    // publicApplication.ts writes first_name "Unknown", last_name
    // "(application started)".
    expect(isPlaceholderName("Unknown (application started)")).toBe(true);
    expect(isPlaceholderName("unknown (APPLICATION STARTED)")).toBe(true);
    expect(isPlaceholderName("Unknown")).toBe(true);
    expect(isPlaceholderName("")).toBe(true);
    expect(isPlaceholderName(null)).toBe(true);
  });

  it("does not mistake a real name for a placeholder", () => {
    expect(isPlaceholderName("Brandon Voss")).toBe(false);
    expect(isPlaceholderName("Unknown Rivera")).toBe(false);
    // A surname really can be Unknown-ish; only the exact forms count.
    expect(isPlaceholderName("Sarah Unknown")).toBe(false);
  });

  it("replaces the placeholder with the real applicant name", () => {
    // This is the reported bug: the CRM header stayed "Unknown (application
    // started)" while the same record held Brandon Voss.
    expect(resolveContactName("Unknown (application started)", "Brandon Voss")).toBe("Brandon Voss");
  });

  it("fills an empty name", () => {
    expect(resolveContactName("", "Brandon Voss")).toBe("Brandon Voss");
    expect(resolveContactName(null, "Brandon Voss")).toBe("Brandon Voss");
  });

  it("never lets a blank submission wipe a good name", () => {
    // The original COALESCE existed for this, and it still holds.
    expect(resolveContactName("Brandon Voss", "")).toBe("Brandon Voss");
    expect(resolveContactName("Brandon Voss", null)).toBe("Brandon Voss");
  });

  it("never lets a placeholder overwrite a real name", () => {
    expect(resolveContactName("Brandon Voss", "Unknown (application started)")).toBe("Brandon Voss");
  });

  it("keeps the first real name when a second arrives", () => {
    // A later application must not silently rename an established contact.
    expect(resolveContactName("Brandon Voss", "B. Voss")).toBe("Brandon Voss");
  });

  it("trims incidental whitespace", () => {
    expect(resolveContactName("  Unknown (application started)  ", "  Brandon Voss  ")).toBe("Brandon Voss");
  });
});
