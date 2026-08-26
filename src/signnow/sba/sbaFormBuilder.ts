// BF_SERVER_SBA_FORM_BUILDER_v95
import { logInfo } from "../../observability/logger.js";
import { fillAcroForm, type FieldMap } from "./fillAcroForm.js";
import { loadSbaTemplate } from "./templates.js";
import { SBA_1919_FIELDS as F19, SBA_912_FIELDS as F12, SBA_413_FIELDS as F413, SBA_912_RADIO_STATES } from "./fieldMaps.js";
import type { SbaOwner } from "./sbaOwners.js";

const s = (v: unknown) => v == null ? "" : String(v).trim();
const yes = (v: unknown) => s(v).toLowerCase() === "yes";
const no = (v: unknown) => s(v).toLowerCase() === "no";
const money = (v: unknown) => {
  const n = Number(s(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n !== 0 ? String(Math.round(n)) : "";
};

function entityBoxes(structure: string): FieldMap {
  const t = s(structure).toLowerCase();
  return {
    [F19.entitySoleProp]: t.includes("sole"), [F19.entityPartnership]: t.includes("partner"),
    [F19.entityCCorp]: t.includes("c-corp") || t === "corporation" || t.includes("c corp"),
    [F19.entitySCorp]: t.includes("s-corp") || t.includes("s corp"),
    [F19.entityLlc]: t.includes("llc") || t.includes("limited liability"),
  };
}

export async function buildSba1919(args: { applicationId: string; business: any; kyc: any; form1919: any; owners: SbaOwner[] }): Promise<Uint8Array | null> {
  const tpl = await loadSbaTemplate("form_1919");
  if (!tpl) return null;
  const { business: b, kyc, form1919: f, owners } = args;
  const values: FieldMap = {
    [F19.applicantLegalName]: s(b.legalName) || s(b.businessName), [F19.isOperatingCompany]: true,
    [F19.dba]: s(b.businessName), [F19.businessTin]: s(b.ein), [F19.naicsCode]: s(b.naicsCode),
    [F19.businessPhone]: s(b.phone), [F19.yearBeganOperations]: s(b.startDate).slice(0, 4),
    ...entityBoxes(b.businessStructure),
    [F19.businessAddress]: [s(b.address), s(b.city), s(b.state), s(b.zip)].filter(Boolean).join(", "),
    [F19.contactName]: owners[0]?.fullName ?? "", [F19.contactEmail]: owners[0]?.email ?? "",
    [F19.existingEmployees]: s(b.employees), [F19.fteRetained]: s(f.fte_retained), [F19.fteCreated]: s(f.fte_created),
    [F19.purposeEquipment]: !!money(f.purpose_equipment), [F19.purposeEquipmentAmt]: money(f.purpose_equipment),
    [F19.purposeRealEstate]: !!money(f.purpose_real_estate), [F19.purposeRealEstateAmt]: money(f.purpose_real_estate),
    [F19.purposeWorkingCap]: !!money(f.purpose_working_capital), [F19.purposeWorkingCapAmt]: money(f.purpose_working_capital),
    [F19.purposeInventory]: !!money(f.purpose_inventory), [F19.purposeInventoryAmt]: money(f.purpose_inventory),
    [F19.purposeAcquisition]: !!money(f.purpose_acquisition), [F19.purposeAcquisitionAmt]: money(f.purpose_acquisition),
    [F19.purposeDebtRefi]: !!money(f.purpose_debt_refi), [F19.purposeDebtRefiAmt]: money(f.purpose_debt_refi),
    [F19.purposeOther1]: !!money(f.purpose_other), [F19.purposeOther1Amt]: money(f.purpose_other),
    [F19.exportSalesTotal]: s(f.q5_exports_detail), [F19.repName]: owners[0]?.fullName ?? "", [F19.repTitle]: owners[0]?.title ?? "",
  };
  // BF_SERVER_SBA_OWNER_CAPACITY_v105 - the form physically holds five. Dropping
  // a sixth owner without a word produces a 1919 that understates ownership, so
  // record it. sbaFormsComplete holds the file in this case; this line is what
  // explains it in the log.
  if (owners.length > F19.MAX_OWNERS) {
    logInfo("sba_1919_owners_truncated", {
      total: owners.length,
      rendered: F19.MAX_OWNERS,
      dropped: owners.length - F19.MAX_OWNERS,
    });
  }
  owners.slice(0, F19.MAX_OWNERS).forEach((owner, index) => {
    const n = index + 1;
    values[F19.ownerName(n)] = owner.fullName; values[F19.ownerTitle(n)] = owner.title;
    values[F19.ownerPercent(n)] = owner.ownershipPercent ? String(owner.ownershipPercent) : "";
    values[F19.ownerTin(n)] = owner.ssn; values[F19.ownerHome(n)] = owner.homeAddress;
  });
  const printed: Record<number, unknown> = {
    1: f.q1_debarred, 2: f.q2_federal_default, 3: f.q3_other_business,
    4: b?.sbaQ4Criminal ?? kyc?.sbaQ4Criminal, 6: f.q6_broker_fee, 7: f.q7_restricted_revenue,
    8: f.q8_sba_employee, 9: f.q9_former_sba, 10: f.q10_congress, 11: f.q11_federal_employee,
    12: f.q12_advisory_council, 13: f.q13_legal_action,
  };
  for (const [number, answer] of Object.entries(printed)) {
    const map = F19.printedQuestion[Number(number)];
    if (yes(answer)) values[map.yes] = true; else if (no(answer)) values[map.no] = true;
  }
  if (yes(f.q5_exports)) s(f.q5_exports_detail).split(",").map((x) => x.trim()).filter(Boolean)
    .slice(0, 3).forEach((country, index) => { values[F19.exportCountry(index + 1)] = country; });
  return fillAcroForm(tpl, values);
}

export async function buildSba912(args: { business: any; owner: SbaOwner }): Promise<Uint8Array | null> {
  const tpl = await loadSbaTemplate("form_912");
  if (!tpl) return null;
  const { business: b, owner: o } = args, R = SBA_912_RADIO_STATES;
  const values: FieldMap = {
    [F12.applicantNameAddress]: [s(b.legalName) || s(b.businessName), [s(b.address), s(b.city), s(b.state), s(b.zip)].filter(Boolean).join(", ")].filter(Boolean).join("\n"),
    [F12.personalStatement]: [o.fullName, o.formerNames].filter(Boolean).join(" — formerly: "),
    [F12.ownershipPercent]: o.ownershipPercent ? String(o.ownershipPercent) : "", [F12.ssn]: o.ssn,
    [F12.dateOfBirth]: o.dob, [F12.placeOfBirth]: o.placeOfBirth, [F12.alienRegNumber]: o.alienRegistrationNumber,
    [F12.presentAddress]: o.homeAddress, [F12.homePhone]: o.homePhone, [F12.businessPhone]: s(b.phone),
    [F12.priorAddress]: o.priorAddress, [F12.title]: o.title,
  };
  if (yes(o.usCitizen)) values[F12.citizenRadio] = R.citizen.yes;
  else if (no(o.usCitizen)) values[F12.citizenRadio] = R.citizen.no;
  if (!o.alienRegistrationNumber && no(o.usCitizen)) values[F12.noAlienRegNumber] = true;
  const question = (answer: string, field: string) => {
    if (yes(answer)) values[field] = R.plain.yes; else if (no(answer)) values[field] = R.plain.no;
  };
  question(o.q8, F12.q8Radio); question(o.q9, F12.q9Radio); question(o.q10, F12.q10Radio);
  return fillAcroForm(tpl, values);
}

export async function buildSba413(args: { business: any; owner: SbaOwner; data: any }): Promise<Uint8Array | null> {
  const tpl = await loadSbaTemplate("form_413");
  if (!tpl) return null;
  const { business: b, owner: o, data: d } = args;
  const num = (key: string) => Number(s(d?.[key]).replace(/[^0-9.-]/g, "")) || 0;
  const assetKeys = ["asset_cash", "asset_savings", "asset_ira", "asset_ar", "asset_life_insurance", "asset_stocks_bonds", "asset_real_estate", "asset_automobiles", "asset_other_personal", "asset_other"];
  const liabilityKeys = ["liab_accounts_payable", "liab_notes_payable", "liab_installment_auto", "liab_installment_other", "liab_life_insurance_loans", "liab_mortgages", "liab_unpaid_taxes", "liab_other"];
  const totalAssets = assetKeys.reduce((total, key) => total + num(key), 0);
  const totalLiabilities = liabilityKeys.reduce((total, key) => total + num(key), 0);
  const t = s(b.businessStructure).toLowerCase(), today = new Date().toLocaleDateString("en-US");
  const values: FieldMap = {
    [F413.purpose7a]: true, [F413.name]: o.fullName, [F413.businessPhone]: s(b.phone),
    [F413.homeAddress]: o.homeAddress, [F413.homePhone]: o.homePhone,
    [F413.businessName]: s(b.legalName) || s(b.businessName),
    [F413.businessAddress]: [s(b.address), s(b.city), s(b.state), s(b.zip)].filter(Boolean).join(", "),
    [F413.typeCorporation]: t === "corporation" || t.includes("c-corp"), [F413.typeSCorp]: t.includes("s-corp") || t.includes("s corp"),
    [F413.typeLlc]: t.includes("llc"), [F413.typePartnership]: t.includes("partner"), [F413.typeSoleProp]: t.includes("sole"),
    [F413.currentAsOf]: today, [F413.printName]: o.fullName, [F413.ssn]: o.ssn, [F413.date]: today,
    [F413.assetCash]: money(d?.asset_cash), [F413.assetSavings]: money(d?.asset_savings), [F413.assetIra]: money(d?.asset_ira),
    [F413.assetAr]: money(d?.asset_ar), [F413.assetLifeInsurance]: money(d?.asset_life_insurance), [F413.assetStocksBonds]: money(d?.asset_stocks_bonds),
    [F413.assetRealEstate]: money(d?.asset_real_estate), [F413.assetAutomobiles]: money(d?.asset_automobiles),
    [F413.assetOtherPersonal]: money(d?.asset_other_personal), [F413.assetOther]: money(d?.asset_other),
    [F413.totalAssets]: totalAssets ? String(Math.round(totalAssets)) : "",
    [F413.liabAccountsPayable]: money(d?.liab_accounts_payable), [F413.liabNotesPayable]: money(d?.liab_notes_payable),
    [F413.liabInstallAuto]: money(d?.liab_installment_auto), [F413.liabInstallAutoMonthly]: money(d?.liab_installment_auto_monthly),
    [F413.liabInstallOther]: money(d?.liab_installment_other), [F413.liabInstallOtherMonthly]: money(d?.liab_installment_other_monthly),
    [F413.liabLifeInsuranceLoans]: money(d?.liab_life_insurance_loans), [F413.liabMortgages]: money(d?.liab_mortgages),
    [F413.liabUnpaidTaxes]: money(d?.liab_unpaid_taxes), [F413.liabOther]: money(d?.liab_other),
    [F413.totalLiabilities]: totalLiabilities ? String(Math.round(totalLiabilities)) : "", [F413.netWorth]: String(Math.round(totalAssets - totalLiabilities)),
    [F413.incomeSalary]: money(d?.income_salary), [F413.incomeNetInvestment]: money(d?.income_net_investment),
    [F413.incomeRealEstate]: money(d?.income_real_estate), [F413.incomeOther]: money(d?.income_other),
    [F413.contEndorser]: money(d?.cont_endorser), [F413.contLegalClaims]: money(d?.cont_legal_claims),
    [F413.contFederalTax]: money(d?.cont_federal_tax), [F413.contOtherSpecial]: money(d?.cont_other_special),
    [F413.section7OtherLiab]: s(d?.notes),
  };
  return fillAcroForm(tpl, values);
}
