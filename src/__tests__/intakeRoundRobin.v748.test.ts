// BF_SERVER_INTAKE_ROUND_ROBIN_v748 / BF_SERVER_V748_TEST_SYNC_v751
// Both v749 blocks ran; the second restored v748's helper names (intakeTeam(staff), intakeExcludes,
// roundRobinPick) on top of the mailbox fix. This checks v748's behaviour against that live code.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { intakeTeam, intakeExcludes, roundRobinPick, type Staff } from "../services/clientBooking.js";

const todd: Staff = { id: "t", email: "todd.w@boreal.financial", first_name: "Todd", signed_in: true, mailbox: "todd.w@boreal.financial" };
const andrew: Staff = { id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" };
const caden: Staff = { id: "c", email: "caden.w@boreal.financial", first_name: "Caden", signed_in: false };

describe("intake round robin for the general booking link", () => {
  afterEach(() => { delete process.env.BOOKING_INTAKE_EXCLUDE; });
  it("is everyone who has signed in except Andrew", () => {
    expect(intakeTeam([todd, andrew, caden]).map((s) => s.id)).toEqual(["t"]);
  });
  it("adds a new staff member the first time they sign in", () => {
    expect(intakeTeam([todd, andrew, { ...caden, signed_in: true }]).map((s) => s.id)).toEqual(["t", "c"]);
  });
  it("the exclusion list can be changed without code", () => {
    process.env.BOOKING_INTAKE_EXCLUDE = "";
    expect(intakeExcludes()).toEqual([]);
    expect(intakeTeam([todd, andrew]).map((s) => s.id)).toEqual(["t", "a"]);
  });
  it("takes turns: the person booked longest ago, or never, goes next", () => {
    const last = new Map([["t", 2000], ["c", 1000]]);
    expect(roundRobinPick(["t", "c"], last)).toBe("c");
    expect(roundRobinPick(["t", "c"], new Map([["t", 5]]))).toBe("c");
    expect(roundRobinPick(["t"], last)).toBe("t");
    expect(roundRobinPick([], last)).toBeNull();
  });
  it("personal links still book that person; only the general link uses the intake team", () => {
    const s = readFileSync("src/services/clientBooking.ts", "utf8");
    expect(s).toContain("const staff = staffId ? everyone.filter((s) => s.id === staffId) : intakeTeam(everyone);");
    expect(s).toContain("roundRobinPick(match.staffIds");
  });
});
