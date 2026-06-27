// BF_SERVER_PNL_DISPLAY_v1
// Display-only transform for client-facing document labels. "PnL" is a
// canonical doc-type identifier (a matching key) and must stay "PnL" in data,
// but it should read as "P&L" wherever it is shown to an applicant (chat
// nudges, etc.). Whole-word, case-insensitive; identifiers are never mutated.
export function prettyDocLabel(label: string): string {
  return String(label ?? "").replace(/\bpnl\b/gi, "P&L");
}
