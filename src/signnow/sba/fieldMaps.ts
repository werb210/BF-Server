// BF_SERVER_SBA_FIELD_MAPS_v90
// Field names read from the live templates (pypdf get_fields), not guessed.
// 1919 has 126 fields, 413 has 147, 912 has 44.
//
// Three things worth knowing before editing any of this:
//
// 1. 1919's INTERNAL field numbers do not match its PRINTED question numbers.
//    q5Yes/q5No carry the tooltip "paid or committed to pay a fee to the
//    Lender/CDC", which is PRINTED question 6. Printed question 5 (exports) has
//    no yes/no pair at all - it is captured by expSalesTot and expCtry1-3.
//    Our CMP form (v199) keys answers by PRINTED number, so the mapping below
//    shifts deliberately. Getting this wrong would put an export answer on the
//    broker-fee question of a federal form that carries criminal penalties for
//    a false statement.
//
// 2. 1919 and 413 use SEPARATE checkboxes per answer (q4Yes and q4No are two
//    distinct fields). 912 uses RADIO GROUPS - one field, with the answer
//    selected by its export value. Those values are not uniform: questions 8, 9
//    and 10 take "/Yes" or "/No", but citizenship takes the full sentence
//    "/Yes, I'm a United States Citizen".
//
// 3. Capacity is fixed by the form. 1919 holds 5 owners, 413 holds 5 noteholder
//    rows, 4 stock rows, 3 properties and 2 signature blocks. Beyond that SBA
//    expects a separate attachment sheet, not more fields.

export const SBA_912_RADIO_STATES = {
  citizen: { yes: "/Yes, I'm a United States Citizen", no: "/No, I'm not a United States Citizen" },
  plain:   { yes: "/Yes", no: "/No" },
} as const;

export const SBA_912_FIELDS = {
  applicantNameAddress: "1a. Name and address of Applicant/Borrower/Assumptor (Firm/Business Name; Street, City, State, Zip Code, and Email):",
  personalStatement:    "1b. Personal Statement of : (State name in full, if no middle name state NMN, or if initial only indicate initial). List all former names used, and dates each name was used. Use separate sheet if necessary",
  ownershipPercent:     "2. Give the percentage of ownership in the small business (if applicable):",
  ssn:                  "3. Social Security Number",
  dateOfBirth:          "4. Date of Birth (month, day, and year)",
  placeOfBirth:         "5. Place of Birth (City & State or Foreign Country)",
  citizenRadio:         "Are you a United States Citizen?",
  alienRegNumber:       "If no, please provide an alien registration number",
  noAlienRegNumber:     "I do not have an alien registration number",
  citizenInitials:      "6. Are you a United States Citizen - Initials",
  presentAddressDates:  "7. Present Residence Address",
  presentAddress:       "7. Present Residence Address - to Address",
  homePhone:            "Home Telephone No. (include area code)",
  businessPhone:        "Business Telephone No. (include area code)",
  priorAddressDates:    "Most recent prior address (omit if over 10 years ago)",
  priorAddress:         "Address",
  q8Radio:  "Are you currently incarcerated, serving a sentence of imprisonment imposed upon adjudication of guilty or under indictment for a felony or any crime",
  q9Radio:  "9. In the past year, have you been convicted of a criminal offense committed during and in connection with a riot or civil disorder or other declared disaster?",
  q10Radio: "10. Are you currently more than 60 days late on paying any child support obligations?",
  title: "Title",
  date:  "Date_af_date",
  // Signature and the three per-question initials are /Sig fields. SignNow owns
  // them - SBA requires "an acceptable electronic signature, and not typed", so
  // a value written here would be exactly what the form refuses.
  signature: "Signature",
} as const;

export const SBA_1919_FIELDS = {
  applicantLegalName: "applicantname",
  isOperatingCompany: "OC",
  isPassiveCompany:   "EPC",
  operatingBusName:   "operatingnbusname",
  dba:                "dba",
  businessTin:        "busTIN",
  naicsCode:          "PrimarIndustry",
  businessPhone:      "busphone",
  samUei:             "UniqueEntityID",
  yearBeganOperations:"yearbeginoperations",
  entitySoleProp:   "soleprop",
  entityPartnership:"partnership",
  entityCCorp:      "ccorp",
  entitySCorp:      "scorp",
  entityLlc:        "llc",
  entityOther:      "etother",
  entityOtherText:  "entityother",
  businessAddress: "busAddr",
  projectAddress:  "projAddr",
  contactName:     "pocName",
  contactEmail:    "pocEmail",
  existingEmployees: "existEmp",
  fteRetained:       "fteJobs",
  fteCreated:        "fteCreate",
  purposeEquipment:  "purpEquip",   purposeEquipmentAmt:  "EquipAmt",
  purposeRealEstate: "purchConstr", purposeRealEstateAmt: "purchAmt",
  purposeWorkingCap: "workCap",     purposeWorkingCapAmt: "capitalAmt",
  purposeInventory:  "purpInv",     purposeInventoryAmt:  "invAmt",
  purposeAcquisition:"busAcq",      purposeAcquisitionAmt:"busAcqAmt",
  purposeDebtRefi:   "debtRef",     purposeDebtRefiAmt:   "debtAmt",
  purposeOther1:     "purpOther1",  purposeOther1Amt:     "otherAmt1", purposeOther1Text: "other1spec",
  ownerName:  (i: number) => `ownName${i}`,
  ownerTitle: (i: number) => `ownTitle${i}`,
  ownerPercent: (i: number) => `ownPerc${i}`,
  ownerTin:   (i: number) => `ownTin${i}`,
  ownerHome:  (i: number) => `ownHome${i}`,
  MAX_OWNERS: 5,
  // PRINTED question -> internal field. Printed Q5 (exports) has no yes/no pair;
  // see the note at the top of this file. Printed Q4 is the disqualifying one.
  printedQuestion: {
    1:  { yes: "q1Yes",  no: "q1No"  },
    2:  { yes: "q2Yes",  no: "q2No"  },
    3:  { yes: "q3Yes",  no: "q3No"  },
    4:  { yes: "q4Yes",  no: "q4No"  },
    6:  { yes: "q5Yes",  no: "q5No"  },
    7:  { yes: "q6Yes",  no: "q6No"  },
    8:  { yes: "q7Yes",  no: "q7No"  },
    9:  { yes: "q8Yes",  no: "q8No"  },
    10: { yes: "q9Yes",  no: "q9No"  },
    11: { yes: "q10Yes", no: "q10No" },
    12: { yes: "q11Yes", no: "q11No" },
    13: { yes: "q12Yes", no: "q12No" },
  } as Record<number, { yes: string; no: string }>,
  exportSalesTotal: "expSalesTot",
  exportCountry: (i: number) => `expCtry${i}`,
  repName: "repName", repTitle: "repTitle", sigDate: "sigDate",
} as const;

export const SBA_413_FIELDS = {
  purpose7a: "7(a) loan/04 loan/Surety Bonds",
  name: "Name", businessPhone: "Business Phone xxx-xxx-xxxx",
  homeAddress: "Home Address", homePhone: "Home Phone xxx-xxx-xxxx",
  cityStateZip: "City, State, & Zip Code",
  businessName: "Business Name of Applicant/Borrower",
  businessAddress: "Business Address (if different than home address)",
  typeCorporation: "Business Type: Corporation",
  typeSCorp:       "Business Type: S-Corp",
  typeLlc:         "Business Type: LLC",
  typePartnership: "Business Type: Partnership",
  typeSoleProp:    "Business Type: Sole Proprietor",
  // SBA requires this within 120 days of submission for 7(a).
  currentAsOf: "This information is current as of month/day/year",
  assetCash: "Cash on Hand & in banks",
  assetSavings: "Savings Accounts",
  assetIra: "IRA or Other Retirement Account",
  assetAr: "Accounts and Notes Receivable",
  assetLifeInsurance: "Life Insurance - Cash Surrender Value Only",
  assetStocksBonds: "Stocks and Bonds",
  assetRealEstate: "Real Estate",
  assetAutomobiles: "Automobiles",
  assetOtherPersonal: "Other Personal Property",
  assetOther: "Other Assets",
  totalAssets: "TotalAssets",
  liabAccountsPayable: "Accounts Payable",
  liabNotesPayable: "Notes Payable to Banks and Others",
  liabInstallAuto: "Installment Account (Auto)",
  liabInstallAutoMonthly: "Installment Account - Monthly Payments (Auto)",
  liabInstallOther: "Installment Account (Other)",
  liabInstallOtherMonthly: "Installment Account - Monthly Payments (Other)",
  liabLifeInsuranceLoans: "Loan(s) Against Life Insurance",
  liabMortgages: "Mortgages on Real Estate",
  liabUnpaidTaxes: "Unpaid Taxes",
  liabOther: "Other Liabilities",
  totalLiabilities: "TotalLiabilities",
  netWorth: "Net Worth",
  incomeSalary: "Salary",
  incomeNetInvestment: "Net Investment Income",
  incomeRealEstate: "Real Estate Income",
  incomeOther: "Other Income",
  contEndorser: "As Endorser or Co-Maker",
  contLegalClaims: "Legal Claims and Judgements",
  contFederalTax: "Provision for Federal Income Tax",
  contOtherSpecial: "Other Special Debt",
  otherIncomeDescription: "Description of Other Income in Section 1: Alimony or child support payments should not be disclosed in Other Income unless it is desired to have such payments counted toward total incomeRow1",
  section5OtherProperty: "Section 5  Other Personal Property and Other Assets: Describe and if any is pledged as security state name and address of lien holder amount of lien terms of payment and if delinquent describe delinquencyRow1",
  section6UnpaidTaxes:   "Section 6 Unpaid Taxes Describe in detail as to type to whom payable when due amount and to what property if any a tax lien attachesRow1",
  section7OtherLiab:     "Section 7 Other Liabilities Describe in detailRow1",
  section8LifeInsurance: "Section 8 Life Insurance Held Give face amount and cash surrender value of policies  name of insurance company and BeneficiariesRow1",
  noteholderName: (i: number) => `Names and Addresses of NoteholdersRow${i}`,
  noteholderOriginalBalance: (i: number) => `Original BalanceRow${i}`,
  noteholderCurrentBalance:  (i: number) => `Current BalanceRow${i}`,
  noteholderPayment:         (i: number) => `Payment AmountRow${i}`,
  noteholderFrequency:       (i: number) => `Frequency monthly etcRow${i}`,
  noteholderCollateral:      (i: number) => `How Secured or Endorsed Type of CollateralRow${i}`,
  MAX_NOTEHOLDER_ROWS: 5,
  propertyType:        (p: "A" | "B" | "C") => `Property ${p}Type of Real Estate eg Primary Residence Other Residence Rental Property Land etc`,
  propertyAddress:     (p: "A" | "B" | "C") => `Property ${p}Address`,
  propertyMarketValue: (p: "A" | "B" | "C") => `Property ${p}Present Market Value`,
  propertyMortgageBalance: (p: "A" | "B" | "C") => `Property ${p}Mortgage Balance`,
  printName: "Print Name", ssn: "Social Security No", date: "Date",
  printName2: "Print Name_2", ssn2: "Social Security No_2", date2: "Date2",
  // Signature and Signature_2 are /Sig - SignNow owns them.
} as const;


// BF_SERVER_SBA_4506C_MAP_v118
// IRS Form 4506-C (Rev. 10-2022), 84 fields, read with pypdf get_fields from the
// official f4506c.pdf. XFA-style hierarchical names, unlike the other three
// forms - the full dotted path is the field name and must be used verbatim.
//
// Four things that will bite whoever edits this:
//
// 1. attestCheckbox is MANDATORY. The IRS instructions say the form "will not be
//    processed if unchecked". It is a checkbox next to the signature that is easy
//    to overlook because it reads like boilerplate.
//
// 2. electronicSignatureCheckbox must be ticked too, because we sign through
//    SignNow. IRS: "If the Form 4506-C is signed electronically, the Electronic
//    Signature check box must be marked."
//
// 3. The signature fields are /Tx, NOT /Sig. On the other three forms SignNow
//    owns a real signature field; here it must place its own tag over a text box.
//    Do not type a name into signature[0] - a typed signature is not a signature.
//
// 4. Line 8 is twelve separate boxes: four date slots of mm / dd / yyyy, named
//    f1_15 through f1_26 in order. They are positional, not labelled.
const P = "form1[0].page_1[0]";

export const SBA_4506C_FIELDS = {
  firstName: `${P}.name_shown[0].first_name[0]`, middleInitial: `${P}.name_shown[0].middle_initial[0]`, lastName: `${P}.name_shown[0].last_name[0]`, taxpayerId: `${P}.name_shown[0].first_ssn[0]`,
  prevFirstName: `${P}.name_shown[0].previous_first_name[0]`, prevMiddleInitial: `${P}.name_shown[0].previous_middle_initial[0]`, prevLastName: `${P}.name_shown[0].previous_last_name[0]`,
  spouseFirstName: `${P}.if_a_joint[0].first_name[0]`, spouseMiddleInit: `${P}.if_a_joint[0].middle_initial[0]`, spouseLastName: `${P}.if_a_joint[0].last_name[0]`, spouseTaxpayerId: `${P}.if_a_joint[0].second_ssn[0]`,
  addressStreet: `${P}.current_name_address[0].street_address[0]`, addressCity: `${P}.current_name_address[0].city[0]`, addressState: `${P}.current_name_address[0].state[0]`, addressZip: `${P}.current_name_address[0].zip_code[0]`,
  prevAddressStreet: `${P}.previous_address_shown[0].street_address[0]`, prevAddressCity: `${P}.previous_address_shown[0].city[0]`, prevAddressState: `${P}.previous_address_shown[0].state[0]`, prevAddressZip: `${P}.previous_address_shown[0].zip_code[0]`,
  ivesName: `${P}.ives_participant_name[0].ives_participant_name[0]`, ivesId: `${P}.ives_participant_name[0].ives_participant_id[0]`, ivesMailboxId: `${P}.ives_participant_name[0].sor_mailbox_id[0]`, ivesStreet: `${P}.ives_participant_name[0].street_address[0]`, ivesCity: `${P}.ives_participant_name[0].city[0]`, ivesState: `${P}.ives_participant_name[0].state[0]`, ivesZip: `${P}.ives_participant_name[0].zip_code[0]`,
  customerFileNumber: `${P}.customer_file_number[0]`, uniqueIdentifier: `${P}.unique_identifer[0]`,
  clientName: `${P}.client_info[0].first_name[0]`, clientPhone: `${P}.client_info[0].telephone_number[0]`, clientStreet: `${P}.client_info[0].street_address[0]`, clientCity: `${P}.client_info[0].city[0]`, clientState: `${P}.client_info[0].state[0]`, clientZip: `${P}.client_info[0].zip_code[0]`,
  transcriptFormNumber: `${P}.transcript_reqeust[0]`, returnTranscript: `${P}.transcript_type[0].return_transcript[0]`, accountTranscript: `${P}.transcript_type[0].account_transcript[0]`, recordOfAccount: `${P}.transcript_type[0].record_of_account[0]`,
  wageIncome: `${P}.question_7[0]`, wageFormNumber: (i: 1 | 2 | 3) => `${P}.#subform[9].form_number${i}[0]`, wageForLine1a: `${P}.taxpayer_requesting[0].line_1a[0]`, wageForLine2a: `${P}.taxpayer_requesting[0].line_2a[0]`,
  periodBox: (i: number) => `${P}.question_8[0].f1_${14 + i}[0]`, PERIOD_BOXES: 12,
  attestCheckbox: `${P}.signature_attests[0]`, signature: `${P}.signature[0]`, signatureDate: `${P}.date[0]`, taxpayerPhone: `${P}.phone_number[0]`, authorizedRepCheckbox: `${P}.form_4506c[0]`, electronicSignatureCheckbox: `${P}.signatory_confirms[0]`, printName: `${P}.print_type_name[0]`, title: `${P}.title[0]`, spouseSignature: `${P}.spouses_signature[0]`, spouseAuthorizedRep: `${P}.spouses_form_4506c[0]`, spouseElectronicSignature: `${P}.spouses_signatory_confirms[0]`, spouseSignatureDate: `${P}.date[1]`, spousePrintName: `${P}.print_type_name[1]`,
} as const;
