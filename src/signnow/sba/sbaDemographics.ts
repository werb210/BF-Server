// BF_SERVER_SBA_DEMOGRAPHICS_v128
// Step4_Applicant has collected veteran status, sex, race and ethnicity since
// the wizard was built. resolveSbaOwners carries all four onto SbaOwner. Nothing
// ever wrote them to the 1919, so applicants answered four optional questions
// and the answers went nowhere. v120 named the fields; this maps the values.
//
// Two things the SBA cares about here that are easy to get wrong:
//
// 1. Blank and "Not disclosed" are different answers. The form has an explicit
//    Not Disclosed box for each category, and leaving all boxes clear reads as
//    an unanswered question rather than a declined one. The wizard's empty
//    option IS "Not disclosed", so it ticks the ND box - it does not skip.
//
// 2. The demographic block on page 2 is a SINGLE block, not one per owner. SBA
//    asks for a separate section per 20%+ owner on an attached sheet; the form
//    itself has room for one. We fill it from owner one and leave the rest to
//    the attachment, rather than silently overwriting with the last owner.
import { SBA_1919_FIELDS as F } from "./fieldMaps.js";
import type { SbaOwner } from "./sbaOwners.js";

// Values are exactly what Step4_Applicant's selects emit. A value that is not
// in these maps ticks nothing, which is the correct outcome for an unrecognised
// answer - better a blank category than a wrong one on a federal form.
const VETERAN: Record<string, string> = {
  non_veteran: F.demoVetNon,
  veteran: F.demoVet,
  service_disabled: F.demoVetDisabled,
  spouse: F.demoVetSpouse,
};

const SEX: Record<string, string> = {
  male: F.demoSexMale,
  female: F.demoSexFemale,
};

const RACE: Record<string, string> = {
  american_indian: F.demoRaceAiAn,
  asian: F.demoRaceAsian,
  black: F.demoRaceBlack,
  pacific_islander: F.demoRaceNhPi,
  white: F.demoRaceWhite,
};

const ETHNICITY: Record<string, string> = {
  hispanic: F.demoEthHispanic,
  not_hispanic: F.demoEthNotHispanic,
};

function tick(
  values: Record<string, unknown>,
  answer: string,
  map: Record<string, string>,
  notDisclosedField: string,
): void {
  const key = String(answer ?? "").trim();
  if (!key) {
    // Empty is the wizard's "Not disclosed" option, not a skipped question.
    values[notDisclosedField] = true;
    return;
  }
  const field = map[key];
  if (field) values[field] = true;
}

export function applyDemographics(
  values: Record<string, unknown>,
  owner: SbaOwner | undefined,
): void {
  if (!owner) return;
  values[F.demoOwnerName] = owner.fullName;
  values[F.demoOwnerPosition] = owner.title;
  tick(values, owner.veteranStatus, VETERAN, F.demoVetNotDisclosed);
  tick(values, owner.sex, SEX, "");
  tick(values, owner.race, RACE, F.demoRaceNotDisclosed);
  tick(values, owner.ethnicity, ETHNICITY, F.demoEthNotDisclosed);
}
