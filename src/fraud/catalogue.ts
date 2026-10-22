// BF_SERVER_v846_FRAUD - the 15 fraud checks (ported from Keystone; Boreal runs all 15). There is no check 3:
// "statement vs live bank data" needed Flinks, which Boreal does not use (Keystone retired it too); the other keys keep their numbers.
export type FraudCheckKey =
  | "fraud_1" | "fraud_2" | "fraud_4" | "fraud_5" | "fraud_6" | "fraud_7" | "fraud_8"
  | "fraud_9" | "fraud_10" | "fraud_11" | "fraud_12" | "fraud_13" | "fraud_14" | "fraud_15" | "fraud_16";

export type FraudCheckDef = {
  key: FraudCheckKey;
  label: string;
  /** What the check looks at, in one sentence (shown in the portal). */
  description: string;
  /** "document" checks have one result per uploaded file; "application" checks one per application. */
  scope: "document" | "application";
  /** Points a red / amber result adds to the fraud score (0-100). */
  weight: { red: number; amber: number };
};

export const FRAUD_CHECKS: readonly FraudCheckDef[] = [
  { key: "fraud_1", label: "Document tamper scan", scope: "document", weight: { red: 30, amber: 10 },
    description: "Looks inside each upload for signs of editing: editing software, re-saves, mixed fonts, text pasted over a scan, re-compressed pages." },
  { key: "fraud_2", label: "Bank statement math check", scope: "document", weight: { red: 35, amber: 12 },
    description: "Re-adds every transaction on each bank statement and checks the running and closing balances." },
  { key: "fraud_4", label: "Duplicate document check", scope: "application", weight: { red: 35, amber: 12 },
    description: "Spots the same file, ID or void cheque (exact copy or near-identical image) on another application." },
  { key: "fraud_5", label: "Revenue vs bank deposits", scope: "application", weight: { red: 25, amber: 10 },
    description: "Compares the revenue on tax returns, financials and the application with the money actually deposited." },
  { key: "fraud_6", label: "Business reality check", scope: "application", weight: { red: 25, amber: 8 },
    description: "Checks the business is registered, the applicant is a director, the address is not a mail drop, and the website and phone look established." },
  { key: "fraud_7", label: "Phone and email risk", scope: "application", weight: { red: 15, amber: 6 },
    description: "Flags internet (VoIP) phone lines, throwaway email addresses, brand-new email domains and names that do not match the email." },
  { key: "fraud_8", label: "ID checks", scope: "application", weight: { red: 30, amber: 10 },
    description: "Matches the name and date of birth on the ID to the applicant, and spots photos of screens and ID images used before." },
  { key: "fraud_9", label: "Device and location check", scope: "application", weight: { red: 25, amber: 8 },
    description: "Notices VPNs and data-centre connections, several businesses applying from one device or connection, and applications from outside your region." },
  { key: "fraud_10", label: "Application behaviour signals", scope: "application", weight: { red: 20, amber: 8 },
    description: "Notices pasted bank and ID numbers, impossibly fast applications and answers identical to another application. No keystrokes are kept." },
  { key: "fraud_11", label: "Loan stacking detector", scope: "application", weight: { red: 30, amber: 12 },
    description: "Finds recent advances and daily or weekly debits from other lenders in the bank data that the applicant did not mention." },
  { key: "fraud_12", label: "Fraud network map", scope: "application", weight: { red: 35, amber: 10 },
    description: "Links applications that share a phone, email, address, bank account, device or director, and shows the network." },
  { key: "fraud_13", label: "Shared fraud watchlist", scope: "application", weight: { red: 40, amber: 0 },
    description: "Checks the applicant against confirmed fraud reported by other brokerages in the Keystone network (hashed, no personal data shared)." },
  { key: "fraud_14", label: "Inside-job alerts", scope: "application", weight: { red: 20, amber: 8 },
    description: "Alerts Admins when staff change banking details on a file, export in bulk, approve their own file or work at unusual hours." },
  { key: "fraud_15", label: "Call voice check", scope: "application", weight: { red: 25, amber: 10 },
    description: "Sends recorded calls with the applicant to a voice-analysis service to spot synthetic or cloned voices." },
  { key: "fraud_16", label: "Fraud score and lender pre-screen", scope: "application", weight: { red: 0, amber: 0 },
    description: "One 0-100 score with plain-English reasons, and a pre-screen summary you can add to the lender package." },
];

const BY_KEY = new Map(FRAUD_CHECKS.map((c) => [c.key, c]));

export function fraudCheck(key: string): FraudCheckDef | undefined {
  return BY_KEY.get(key as FraudCheckKey);
}

export function isFraudCheckKey(v: unknown): v is FraudCheckKey {
  return typeof v === "string" && BY_KEY.has(v as FraudCheckKey);
}
