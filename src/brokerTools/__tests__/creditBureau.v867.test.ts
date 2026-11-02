// BF_SERVER_v867_BROKER_TOOLS_CREDIT_BUREAU - providers, consent, pulls and the summary the scorecard and credit summary read.
import { afterEach, describe, expect, it } from "vitest";
import {
  BureauError, applicantFrom, consentText, giveConsent, mockProvider, parseSubject, providerFor, providerStatus, pullCredit, setBureauProvider,
} from "../creditBureau.js";

afterEach(() => { setBureauProvider(null); delete process.env.CREDIT_BUREAU_MOCK; });

const subject = { first_name: "Ann", last_name: "Client", date_of_birth: "1980-04-02", email: null, street: "1 Main St", city: "Edmonton", province: "AB", postal_code: "T5J 0A1" };

describe("credit bureau", () => {
  it("serves the bureau's own connector only when it is set up; otherwise the test provider where allowed", () => {
    expect(providerFor("equifax_ca")?.id).toBe("mock"); // NODE_ENV=test
    const st = providerStatus();
    expect(st.map((p) => [p.bureau, p.test_mode])).toEqual([["equifax_ca", true], ["transunion_ca", true]]);
    expect(st[0]!.setup).toContain("EQUIFAX_CA_MEMBER_NUMBER");
  });

  it("the mock gives the same report for the same person, and no file for 'No Hit'", async () => {
    const a = await mockProvider.pull("equifax_ca", subject), b = await mockProvider.pull("equifax_ca", subject);
    expect(a.score).toBe(b.score);
    expect(a.score! >= 520 && a.score! < 820).toBe(true);
    expect(a.pdf?.subarray(0, 4).toString()).toBe("%PDF");
    expect((await mockProvider.pull("transunion_ca", { ...subject, last_name: "No Hit" })).hit).toBe(false);
  });

  it("reads the applicant and checks a typed person", () => {
    expect(applicantFrom({ metadata: { applicant: { firstName: "Ann", lastName: "Client", dob: "1980-04-02" }, business: { province: "AB" } } }, null))
      .toMatchObject({ first_name: "Ann", last_name: "Client", date_of_birth: "1980-04-02", province: "AB" });
    expect(parseSubject({ first_name: "Ann" })).toBe("Enter the person's first and last name.");
    expect(parseSubject({ first_name: "Ann", last_name: "C", date_of_birth: "02/04/1980" })).toBe("The date of birth is YYYY-MM-DD.");
    expect(consentText("Ann Client")).toContain("Equifax Canada and/or TransUnion Canada");
  });

  it("takes consent only with the person's own name typed and a date of birth", async () => {
    let row: Record<string, any> = { id: "c1", status: "requested", subject: { ...subject, date_of_birth: null }, consent_text: "x" };
    const q = { query: async (sql: string, p: unknown[] = []) => {
      if (/^SELECT .* FROM credit_consents WHERE application_id/s.test(sql)) return { rows: [row] };
      if (/UPDATE credit_consents SET status = 'given'/.test(sql)) { row = { ...row, status: "given", given_name: p[2], subject: { ...row.subject, date_of_birth: p[5] } }; return { rows: [row] }; }
      throw new Error("unexpected SQL: " + sql.slice(0, 60));
    } };
    const meta = { ip: "1.2.3.4", ua: "test" };
    expect(await giveConsent(q, "a1", "c1", { full_name: "Ann Client", agree: false }, meta)).toBe("Tick the box to give your consent.");
    expect(await giveConsent(q, "a1", "c1", { full_name: "Bob", agree: true, date_of_birth: "1980-04-02" }, meta)).toBe("Type your full name as Ann Client.");
    expect(await giveConsent(q, "a1", "c1", { full_name: "ann  client", agree: true }, meta)).toBe("Enter your date of birth (the bureau needs it to find your file).");
    const ok = await giveConsent(q, "a1", "c1", { full_name: "Ann Client", agree: true, date_of_birth: "1980-04-02" }, meta);
    expect(typeof ok !== "string" && ok.status).toBe("given");
  });

  it("refuses a pull without consent, and a bureau that is not set up", async () => {
    const consent = (o: Record<string, unknown>) => ({ query: async (sql: string) => {
      if (/FROM credit_consents/.test(sql)) return { rows: [{ id: "c1", subject, ...o }] };
      throw new Error("unexpected SQL: " + sql.slice(0, 60));
    } });
    await expect(pullCredit(consent({ status: "requested" }), "a1", "c1", "equifax_ca", null, async () => null)).rejects.toMatchObject({ code: "no_consent" });
    await expect(pullCredit(consent({ status: "given", given_at: new Date(Date.now() - 100 * 86_400_000) }), "a1", "c1", "equifax_ca", null, async () => null)).rejects.toMatchObject({ code: "no_consent" });
    setBureauProvider({ id: "equifax_ca", setup: [], configured: () => true, pull: async () => { throw new BureauError("not on", "not_configured"); } });
    await expect(pullCredit(consent({ status: "given", given_at: new Date() }), "a1", "c1", "equifax_ca", null, async () => null)).rejects.toMatchObject({ code: "not_configured" });
  });
});
