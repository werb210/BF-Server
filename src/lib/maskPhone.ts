// BF_SERVER_v789_PHONE_LOG_MASK
// Log lines must not carry a full phone number (PII in the Azure log stream). Keep only
// the last 4 digits so support can still correlate a report with a log line.
export function maskPhoneLast4(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}

// Masks any phone-like run of 7+ digits inside free text (e.g. a Twilio error message
// that echoes the "To" number).
export function maskPhonesInText(text: unknown): string {
  return String(text ?? "").replace(/\+?\d[\d\s().-]{5,}\d/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 7 ? maskPhoneLast4(digits) : match;
  });
}
