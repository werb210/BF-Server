// BF_SERVER_SBA_FIELD_GAPS_v134
// Found by dumping every field of every form against the real templates and
// reading what was still empty. Source-text tests cannot see a blank box.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
const owners = readFileSync(resolve(__dirname, "..", "sbaOwners.ts"), "utf-8");

describe("the owner keeps the parts of its address", () => {
  it("splits street from city/state/zip instead of only joining them", () => {
    expect(owners).toContain("homeStreet: s(raw?.street)");
    expect(owners).toContain('homeCityStateZip: [s(raw?.city), s(raw?.state), s(raw?.zip)].filter(Boolean).join(", ")');
  });
  it("still exposes the joined form for callers that want it", () => {
    expect(owners).toContain("homeAddress: [s(raw?.street), s(raw?.city), s(raw?.state), s(raw?.zip)]");
  });
  it("carries addressSince, which the wizard collected and nothing read", () => {
    expect(owners).toContain("addressSince: s(raw?.addressSince)");
    expect(owners).toContain("addressSince: string");
  });
});
describe("413 fills both address lines", () => {
  it("writes City, State & Zip, which was blank", () => { expect(builder).toContain("[F413.cityStateZip]: o.homeCityStateZip"); });
  it("falls back to the joined address on older records", () => { expect(builder).toContain("o.homeStreet || o.homeAddress"); });
});
describe("1919 does not tick OC and leave the name blank", () => {
  it("writes the operating business name", () => { expect(builder).toContain("[F19.operatingBusName]"); });
  it("still asserts OC", () => { expect(builder).toContain("[F19.isOperatingCompany]: true"); });
});
describe("912 residence dates", () => {
  it("writes how long at the present address", () => {
    expect(builder).toContain("[F12.presentAddressDates]"); expect(builder).toContain("to present");
  });
  it("leaves them blank rather than guessing when addressSince is absent", () => {
    expect(builder).toContain('o.addressSince ? `${o.addressSince} to present` : ""');
  });
});
describe("a dropped export country is reported", () => {
  it("logs rather than truncating in silence", () => { expect(builder).toContain("sba_1919_export_countries_truncated"); });
  it("still only writes the three the form holds", () => { expect(builder).toContain("countries.slice(0, 3)"); });
});
