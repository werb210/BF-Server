import { describe, it, expect } from "vitest";
import { parseIdentity, formatPhoneForDisplay, nameFromParts, resolveDisplayName, type Queryable } from "../callerDisplay.js";

const STAFF = "3f1c2a44-9b21-4c3e-8f77-0a1b2c3d4e5f";
const APP = "550e8400-e29b-41d4-a716-446655440000";
function db(rows: any[]): Queryable { return { query: async () => ({ rows }) }; }
const empty = db([]);

describe("BF_SERVER_CALLER_DISPLAY_v148", () => {
  it("classifies staff, client, anonymous, and phone identities", () => {
    expect(parseIdentity(STAFF)).toMatchObject({ kind: "staff", ref: STAFF, fallback: "Boreal staff" });
    expect(parseIdentity(`client-${APP}`)).toMatchObject({ kind: "client_application", ref: APP, fallback: "Applicant" });
    expect(parseIdentity("client-anon-x9f2")).toMatchObject({ kind: "client_anonymous", fallback: "Website visitor" });
    expect(parseIdentity("+15875551234").kind).toBe("pstn");
    expect(parseIdentity("(587) 555-1234").kind).toBe("pstn");
  });

  it("formats NANP numbers and leaves others as dialled", () => {
    expect(formatPhoneForDisplay("+15875551234")).toBe("(587) 555-1234");
    expect(formatPhoneForDisplay("5875551234")).toBe("(587) 555-1234");
    expect(formatPhoneForDisplay("+442079460000")).toBe("+442079460000");
  });

  it("builds a name from available parts and prefers a person", () => {
    expect(nameFromParts({ firstName: "Todd", lastName: "Werboweski", companyName: "Acme" })).toBe("Todd Werboweski");
    expect(nameFromParts({ companyName: "Acme Ltd" })).toBe("Acme Ltd");
    expect(nameFromParts({ email: "a@b.ca" })).toBe("a@b.ca");
    expect(nameFromParts({})).toBeNull();
  });

  it("resolves staff, applicant, company, and PSTN names", async () => {
    expect(await resolveDisplayName(db([{ first_name: "Caden", last_name: "Werboweski" }]), STAFF)).toBe("Caden Werboweski");
    expect(await resolveDisplayName(db([{ first_name: "Liam", last_name: "Spicer", company_name: "Spicer Haulage" }]), `client-${APP}`)).toBe("Liam Spicer");
    expect(await resolveDisplayName(db([{ first_name: null, last_name: null, company_name: "Spicer Haulage" }]), `client-${APP}`)).toBe("Spicer Haulage");
    expect(await resolveDisplayName(db([{ first_name: "Dana", last_name: "Reyes" }]), "+15875551234")).toBe("Dana Reyes");
  });

  it("uses safe fallbacks instead of identifiers", async () => {
    expect(await resolveDisplayName(empty, "+15875551234")).toBe("(587) 555-1234");
    expect(await resolveDisplayName(empty, STAFF)).toBe("Boreal staff");
    expect(await resolveDisplayName(empty, `client-${APP}`)).toBe("Applicant");
    expect(await resolveDisplayName(empty, "")).toBe("Unknown caller");
    expect(await resolveDisplayName(empty, null)).toBe("Unknown caller");
  });

  it("honours real supplied names but ignores echoed identifiers", async () => {
    expect(await resolveDisplayName(empty, STAFF, "Caden W")).toBe("Caden W");
    expect(await resolveDisplayName(empty, STAFF, STAFF)).toBe("Boreal staff");
  });

  it("never throws when the database is unavailable", async () => {
    const broken: Queryable = { query: async () => { throw new Error("no db"); } };
    expect(await resolveDisplayName(broken, STAFF)).toBe("Boreal staff");
    expect(await resolveDisplayName(broken, "+15875551234")).toBe("(587) 555-1234");
  });
});
