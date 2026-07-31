import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTANT_ALLOWED_MIME_PREFIXES,
  isAllowedAccountantMime,
} from "../routes/accountant.js";

const route = readFileSync(fileURLToPath(new URL("../routes/accountant.ts", import.meta.url)), "utf-8");
const documents = readFileSync(fileURLToPath(new URL("../routes/documents.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_ACCOUNTANT_UPLOAD_v1", () => {
  it("accepts the file types the applicant upload accepts", () => {
    expect(isAllowedAccountantMime("application/pdf")).toBe(true);
    expect(isAllowedAccountantMime("image/jpeg")).toBe(true);
    expect(isAllowedAccountantMime("text/csv")).toBe(true);
  });

  it("accepts Office mimes, whose prefix continues with a dot", () => {
    expect(isAllowedAccountantMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isAllowedAccountantMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
  });

  it("rejects executables and empty mimes", () => {
    expect(isAllowedAccountantMime("application/x-msdownload")).toBe(false);
    expect(isAllowedAccountantMime("")).toBe(false);
    expect(isAllowedAccountantMime(null)).toBe(false);
  });

  it("has not drifted from the applicant upload allowlist", () => {
    for (const prefix of ACCOUNTANT_ALLOWED_MIME_PREFIXES) expect(documents).toContain(`"${prefix}"`);
  });

  it("enforces the allow-list on write, not only on read", () => {
    expect(route).toContain("CATEGORY_NOT_PERMITTED");
    expect(route).toContain("!isAccountantVisible(category) && !ACCOUNTANT_ALWAYS_AVAILABLE.includes(category)");
  });

  it("scopes ownership to the token's contact", () => {
    expect(route).toContain("AND contact_id::text = ($2)::text");
  });

  it("refuses uploads onto a closed file", () => {
    expect(route).toContain("APPLICATION_NOT_ACCEPTING_UPLOADS");
  });

  it("shares the applicant persistence path rather than forking it", () => {
    expect(route).toContain("persistAndEnqueue");
    expect(documents).toContain("export async function persistAndEnqueue");
  });

  it("records who sent it", () => {
    expect(route).toContain("uploadedBy: `accountant:${contactId}`");
  });
});
