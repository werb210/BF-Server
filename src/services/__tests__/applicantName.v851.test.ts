// BF_SERVER_v851_APPLICANT_NAME - the placeholder name helper and the signing name resolver.
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import {
  isPlaceholderName, realName, applicantNameFrom, contactNameFrom, withoutPlaceholderNames, resolveApplicantName,
} from "../applicantName.js";

const APP = "5f0c1d2e-0000-4000-8000-000000000851";
const RESOLVE_SQL = /AS v851_applicant/;
const WRITE_SQL = /UPDATE applications[\s\S]*'\{applicant\}'/;

describe("v851 placeholder names", () => {
  it("recognises the OTP placeholder in every shape", () => {
    for (const v of ["Unknown", "unknown", " Unknown ", "(application started)", "Unknown (application started)", "Unknown  (Application Started)"]) {
      expect(isPlaceholderName(v)).toBe(true);
      expect(realName(v)).toBeNull();
    }
    expect(isPlaceholderName("")).toBe(false);
    expect(realName("")).toBeNull();
    expect(realName(null)).toBeNull();
    expect(realName("  Jordan   Rivers ")).toBe("Jordan Rivers");
    expect(isPlaceholderName("Jordan Rivers")).toBe(false);
  });

  it("reads a real name from the application's applicant block, ignoring the placeholder", () => {
    expect(applicantNameFrom({ firstName: "Unknown", lastName: "(application started)" })).toBeNull();
    expect(applicantNameFrom({ firstName: "", lastName: "", fullName: "Unknown (application started)" })).toBeNull();
    expect(applicantNameFrom(null)).toBeNull();
    expect(applicantNameFrom({ firstName: "Jordan", lastName: "Rivers" })).toEqual({ first: "Jordan", last: "Rivers", full: "Jordan Rivers" });
    expect(applicantNameFrom({ fullName: "Jordan P Rivers" })).toEqual({ first: "Jordan", last: "P Rivers", full: "Jordan P Rivers" });
  });

  it("reads a real name from a CRM contact (first/last, else name)", () => {
    expect(contactNameFrom({ first_name: "Unknown", last_name: "(application started)", name: "Unknown (application started)" })).toBeNull();
    expect(contactNameFrom({ first_name: "Unknown", last_name: "(application started)", name: "Jordan Rivers" })).toEqual({ first: "Jordan", last: "Rivers", full: "Jordan Rivers" });
    expect(contactNameFrom({ first_name: "Jordan", last_name: "Rivers", name: "whatever" })?.full).toBe("Jordan Rivers");
  });

  it("drops placeholder name fields from a prefill applicant block", () => {
    expect(withoutPlaceholderNames({ firstName: "Unknown", lastName: "(application started)", email: "s@x.co" })).toEqual({ email: "s@x.co" });
    expect(withoutPlaceholderNames({ firstName: "Unknown", lastName: "(application started)" })).toBeNull();
    expect(withoutPlaceholderNames({ firstName: "Jordan", lastName: "Rivers" })).toEqual({ firstName: "Jordan", lastName: "Rivers" });
    expect(withoutPlaceholderNames(null)).toBeNull();
  });
});

describe("v851 resolveApplicantName", () => {
  const placeholderApplicant = { firstName: "Unknown", lastName: "(application started)", email: "s@x.co" };

  it("keeps the application's own real name and writes nothing", async () => {
    const query = vi.fn(answerBySql([[RESOLVE_SQL, { rows: [{ v851_applicant: { firstName: "Jordan", lastName: "Rivers" }, v851_contact_name: "Other Person" }] }]]));
    const r = await resolveApplicantName(APP, { query });
    expect(r).toEqual({ status: "ok", name: { first: "Jordan", last: "Rivers", full: "Jordan Rivers" } });
    expect(callsMatching(query, WRITE_SQL)).toHaveLength(0);
  });

  it("uses the corrected CRM contact name and writes it back into metadata.applicant", async () => {
    const query = vi.fn(answerBySql([[RESOLVE_SQL, { rows: [{
      v851_applicant: placeholderApplicant, v851_contact_first: "Jordan", v851_contact_last: "Rivers", v851_contact_name: "Jordan Rivers",
    }] }]]));
    const r = await resolveApplicantName(APP, { query });
    expect(r).toEqual({ status: "repaired", name: { first: "Jordan", last: "Rivers", full: "Jordan Rivers" } });
    const writes = callsMatching(query, WRITE_SQL);
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual([APP, "Jordan", "Rivers", "Jordan Rivers"]);
    expect(String(writes[0][0])).toContain("'firstName', $2::text, 'lastName', $3::text, 'fullName', $4::text");
  });

  it("is missing when neither the application nor the contact has a real name", async () => {
    const query = vi.fn(answerBySql([[RESOLVE_SQL, { rows: [{
      v851_applicant: placeholderApplicant, v851_contact_first: "Unknown", v851_contact_last: "(application started)", v851_contact_name: "Unknown (application started)",
    }] }]]));
    expect(await resolveApplicantName(APP, { query })).toEqual({ status: "missing" });
    expect(callsMatching(query, WRITE_SQL)).toHaveLength(0);
  });

  it("is unknown (and logged) when the application cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn(answerBySql([[RESOLVE_SQL, new Error("boom")]]));
    expect(await resolveApplicantName(APP, { query })).toEqual({ status: "unknown" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(await resolveApplicantName(APP, { query: vi.fn(answerBySql([])) })).toEqual({ status: "unknown" });
  });
});
