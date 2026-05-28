// BF_SERVER_BLOCK_v660_PUBSTART_REQUESTEDAMOUNT_TYPECAST
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.resolve(__dirname, "../publicApplication.ts"),
  "utf8"
);

describe("v660 — requestedAmount is cast so NULL no longer 500s the start route", () => {
  it("requestedAmount uses NULLIF plus an explicit ::numeric cast", () => {
    expect(src).toMatch(/'requestedAmount',\s*NULLIF\(\$10::text,\s*''\)::numeric/);
  });

  it("the readiness_update_draft jsonb_build_object still casts the other text fields", () => {
    // Sanity — make sure we didn't accidentally drop other casts when editing.
    for (const field of [
      "fullName",
      "email",
      "phone",
      "industry",
      "businessLocation",
      "fundingType",
      "purposeOfFunds",
    ]) {
      const re = new RegExp(`'${field}',\\s*\\$\\d+::text`);
      expect(src, `${field} should still be ::text-cast`).toMatch(re);
    }
  });
});
