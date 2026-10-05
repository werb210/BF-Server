// BF_SERVER_INTAKE_ROUND_ROBIN_v748 / BF_SERVER_V748_TEST_REPAIR_v750
// v749 replaced v748's helpers (intakeTeam(staff), intakeExcludes, roundRobinPick) with intakeFilter and
// pickRoundRobin, and "signed in" now means connected to Office 365 (a real mailbox). Same behaviour, checked here.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { intakeFilter, pickRoundRobin, DEFAULT_INTAKE_EXCLUDE, type Staff } from "../services/clientBooking.js";

const todd: Staff = { id: "t", email: "todd.w@boreal.financial", first_name: "Todd", mailbox: "todd.w@boreal.financial", o365: true };
const andrew: Staff = { id: "a", email: "andrew.p@boreal.financial", first_name: "Andrew", mailbox: "andrew.p@boreal.financial", o365: true };
const caden: Staff = { id: "c", email: "caden.w@boreal.financial", first_name: "Caden", mailbox: "caden.w@boreal.financial", o365: false };

describe("intake round robin for the general booking link", () => {
  afterEach(() => { delete process.env.BOOKING_INTAKE_EXCLUDE; });
  it("is everyone who has signed in except Andrew", () => {
    expect(intakeFilter([todd, andrew, caden]).map((s) => s.id)).toEqual(["t"]);
    expect(DEFAULT_INTAKE_EXCLUDE).toContain("andrew.p@boreal.financial");
  });
  it("adds a new staff member the first time they sign in", () => {
    expect(intakeFilter([todd, andrew, { ...caden, o365: true }]).map((s) => s.id)).toEqual(["t", "c"]);
  });
  it("the exclusion list can be changed without code", () => {
    process.env.BOOKING_INTAKE_EXCLUDE = "";
    expect(intakeFilter([todd, andrew]).map((s) => s.id)).toEqual(["t", "a"]);
  });
  it("takes turns: the person booked longest ago, or never, goes next", () => {
    const staff = [todd, { ...caden, o365: true }];
    const last = new Map([["t", 2000], ["c", 1000]]);
    expect(pickRoundRobin(["t", "c"], last, staff)).toBe("c");
    expect(pickRoundRobin(["t", "c"], new Map([["t", 5]]), staff)).toBe("c");
    expect(pickRoundRobin(["t"], last, staff)).toBe("t");
  });
  it("personal links still book that person; only the general link uses the intake team", () => {
    const s = readFileSync("src/services/clientBooking.ts", "utf8");
    expect(s).toContain("const staff = staffId ? (await bookableStaff()).filter((s) => s.id === staffId) : await intakeTeam();");
    expect(s).toContain("const pickId = input.staffId ?? pickRoundRobin(match.staffIds, lastBooked, staffList);");
  });
});
