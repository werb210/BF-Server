// BF_SERVER_DOC_LABELS_v2 - client-facing names for the short internal document types
// ("A/P", "A/R", "PnL – Interim financials"), which read as jargon to applicants.
const FRIENDLY: Array<[RegExp, string]> = [
  [/^\s*a\s*\/\s*p\s*$/i, "Accounts payable aging report"],
  [/^\s*a\s*\/\s*r\s*$/i, "Accounts receivable aging report"],
  [/^\s*(pnl|p&l|profit\s*(and|&)\s*loss)\s*[–—-]\s*interim financials\s*$/i, "Interim profit and loss statement"],
  [/^\s*balance sheet\s*[–—-]\s*interim financials\s*$/i, "Interim balance sheet"],
  [/^\s*3 years accountant prepared financials\s*$/i, "Accountant-prepared financial statements (last 3 years)"],
  [/^\s*6 months business banking statements\s*$/i, "Business bank statements (last 6 months)"],
];

export function prettyDocLabel(label: string): string {
  const raw = String(label ?? "");
  for (const [re, name] of FRIENDLY) if (re.test(raw)) return name;
  return raw.replace(/\bpnl\b/gi, "P&L");
}
