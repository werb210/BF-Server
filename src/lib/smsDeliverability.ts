// BF_SERVER_SMS_LOOP_KILL_v121
export const PERMANENT_SMS_ERROR_CODES = [
  21211, 21214, 21408, 21610, 21612, 21614, 30003, 30005, 30006,
] as const;

export function twilioErrorCode(err: unknown): number {
  const raw = (err as { code?: unknown; status?: unknown } | null)?.code
    ?? (err as { code?: unknown; status?: unknown } | null)?.status;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function isPermanentSmsFailure(err: unknown): boolean {
  return (PERMANENT_SMS_ERROR_CODES as readonly number[]).includes(twilioErrorCode(err));
}

/** True when the number is provably unable to receive SMS. */
export function isUndeliverableNumber(raw: unknown): boolean {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 10) return true;
  if (/^(.)\1+$/.test(digits)) return true;
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return digits.length < 10;
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  if (area[0] < "2" || exchange[0] < "2") return true;
  if (exchange === "555") return true;
  if (national === "1234567890" || national === "2345678901") return true;
  return false;
}
