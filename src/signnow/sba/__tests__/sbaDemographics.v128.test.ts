// BF_SERVER_SBA_DEMOGRAPHICS_v128
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyDemographics } from "../sbaDemographics.js";
import { SBA_1919_FIELDS as F } from "../fieldMaps.js";
import type { SbaOwner } from "../sbaOwners.js";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");

function owner(over: Partial<SbaOwner> = {}): SbaOwner {
  return {
    index: 1, firstName: "Dana", lastName: "Okafor", fullName: "Dana Okafor",
    email: "", title: "Managing Member", ownershipPercent: 60, ssn: "", dob: "",
    homeAddress: "", homePhone: "", placeOfBirth: "", usCitizen: "",
    alienRegistrationNumber: "", formerNames: "", priorAddress: "",
    q8: "", q9: "", q10: "",
    veteranStatus: "", sex: "", race: "", ethnicity: "",
    ...over,
  } as SbaOwner;
}

describe("the answers reach the form", () => {
  it("writes the owner name and position", () => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner());
    expect(v[F.demoOwnerName]).toBe("Dana Okafor");
    expect(v[F.demoOwnerPosition]).toBe("Managing Member");
  });

  it.each([
    ["non_veteran", F.demoVetNon], ["veteran", F.demoVet],
    ["service_disabled", F.demoVetDisabled], ["spouse", F.demoVetSpouse],
  ])("veteran status %s ticks its own box", (answer, field) => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner({ veteranStatus: answer }));
    expect(v[field]).toBe(true);
    expect(v[F.demoVetNotDisclosed]).toBeUndefined();
  });

  it.each([["male", F.demoSexMale], ["female", F.demoSexFemale]])("sex %s", (a, f) => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner({ sex: a }));
    expect(v[f]).toBe(true);
  });

  it.each([
    ["american_indian", F.demoRaceAiAn], ["asian", F.demoRaceAsian],
    ["black", F.demoRaceBlack], ["pacific_islander", F.demoRaceNhPi],
    ["white", F.demoRaceWhite],
  ])("race %s", (a, f) => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner({ race: a }));
    expect(v[f]).toBe(true);
  });

  it.each([["hispanic", F.demoEthHispanic], ["not_hispanic", F.demoEthNotHispanic]])("ethnicity %s", (a, f) => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner({ ethnicity: a }));
    expect(v[f]).toBe(true);
  });
});

describe("blank means declined, not unanswered", () => {
  it("ticks Not Disclosed for the categories that have one", () => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner());
    expect(v[F.demoVetNotDisclosed]).toBe(true);
    expect(v[F.demoRaceNotDisclosed]).toBe(true);
    expect(v[F.demoEthNotDisclosed]).toBe(true);
  });

  it("leaves sex clear, because the form has no Not Disclosed box for it", () => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner());
    expect(v[F.demoSexMale]).toBeUndefined();
    expect(v[F.demoSexFemale]).toBeUndefined();
  });
});

describe("it refuses to guess", () => {
  it("ticks nothing for an answer it does not recognise", () => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, owner({ race: "prefer_not_to_say", veteranStatus: "reservist" }));
    expect(Object.values(v).filter((x) => x === true)).toHaveLength(2); // eth + race ND only
    expect(v[F.demoRaceAiAn]).toBeUndefined();
    expect(v[F.demoVet]).toBeUndefined();
  });

  it("does nothing at all when there is no owner", () => {
    const v: Record<string, unknown> = {};
    applyDemographics(v, undefined);
    expect(Object.keys(v)).toHaveLength(0);
  });
});

describe("wiring", () => {
  it("the builder fills the block from owner one only", () => {
    expect(builder).toContain("applyDemographics(values, owners[0])");
  });

  it("is not inside the owner loop, which would overwrite it per owner", () => {
    const loop = builder.indexOf("owners.slice(0, F19.MAX_OWNERS).forEach");
    const call = builder.indexOf("applyDemographics(values, owners[0])");
    const loopEnd = builder.indexOf("});", loop);
    expect(call).toBeGreaterThan(loopEnd);
  });
});
