// BF_SERVER_4506C_ADDRESS_v157
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
const owners = readFileSync(resolve(__dirname, "..", "sbaOwners.ts"), "utf-8");
const signing = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");

describe("line 3 - the taxpayer's current address", () => {
  it("the owner carries city, state and zip separately", () => {
    expect(owners).toContain("homeCity: string; homeState: string; homeZip: string;");
    expect(owners).toContain("homeCity: s(raw?.city), homeState: s(raw?.state), homeZip: s(raw?.zip),");
  });
  it("the builder reads fields that exist", () => {
    expect(builder).toContain("[F.addressCity]: s(o.homeCity)");
    expect(builder).toContain("[F.addressState]: s(o.homeState)");
    expect(builder).toContain("[F.addressZip]: s(o.homeZip)");
  });
  it("no longer casts away the type error that hid this", () => {
    expect(builder).not.toContain("s((o as any).city)");
    expect(builder).not.toContain("s((o as any).state)");
    expect(builder).not.toContain("s((o as any).zip)");
  });
  it("puts only the street on the street line", () => {
    expect(builder).toContain("[F.addressStreet]: s(o.homeStreet) || s(o.homeAddress)");
  });
});

describe("a value that will not fit is reported as such", () => {
  const fill = readFileSync(resolve(__dirname, "..", "fillAcroForm.ts"), "utf-8");
  it("does not file an overflow under unknown fields", () => {
    expect(fill).toContain("sba_form_fill_value_too_long");
    expect(fill).toContain("maxLength=");
  });
  it("still reports a genuinely unknown field separately", () => {
    expect(fill).toContain("missing.push(name)");
    expect(fill).toContain("sba_form_fill_unknown_fields");
  });
  it("logs enough to act on", () => {
    expect(fill).toContain("maxLength: Number(over[1])");
    expect(fill).toContain("value: String(values[name]");
  });
});

describe("line 5d - the client block the IRS will not accept blank", () => {
  it("mirrors 5a, which the instructions sanction", () => {
    expect(builder).toContain("[F.clientStreet]: ivesStreet, [F.clientCity]: ivesCity");
    expect(builder).toContain("[F.clientState]: ivesState, [F.clientZip]: ivesZip");
  });
  it("no longer reads variables that do not exist", () => {
    for (const v of ["SBA_IVES_CLIENT_STREET", "SBA_IVES_CLIENT_CITY", "SBA_IVES_CLIENT_STATE", "SBA_IVES_CLIENT_ZIP"]) {
      expect(builder).not.toContain(v);
    }
  });
  it("takes the telephone number from the lender", () => {
    expect(builder).toContain("s(args.ives?.phone)");
    expect(signing).toContain("COALESCE(NULLIF(l.main_phone,''), NULLIF(l.contact_phone,'')) AS phone");
  });
  it("5a and 5d resolve from one source, so they cannot disagree", () => {
    expect(builder).toContain("const ivesStreet = s(args.ives?.street)");
    expect(builder).toContain("[F.ivesStreet]: ivesStreet, [F.ivesCity]: ivesCity");
  });
});
