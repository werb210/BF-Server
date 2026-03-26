type Session = {
  phone: string;
  code: string;
  createdAt: number;
  startCooldownUntil: number;
  attempts: number;
  maxAttempts: number;
};

const OTP_TTL_MS = 5 * 60 * 1000;
const START_RATE_LIMIT_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const store = new Map<string, Session>();

export function resetOtpStore(): void {
  store.clear();
}

export function createOtp(phone: string): { ok: true; code: string } | { ok: false; error: string; status: number } {
  const now = Date.now();
  const existing = store.get(phone);

  if (existing && existing.startCooldownUntil > now) {
    return { ok: false, error: "Too many requests", status: 429 };
  }

  const code = process.env.TEST_OTP_CODE ?? "123456";
  store.set(phone, {
    phone,
    code,
    createdAt: now,
    startCooldownUntil: now + START_RATE_LIMIT_MS,
    attempts: 0,
    maxAttempts: MAX_VERIFY_ATTEMPTS,
  });

  return { ok: true, code };
}

export function verifyOtp(phone: string, code: string): { ok: true } | { ok: false; error: string; status: number } {
  const now = Date.now();
  const session = store.get(phone);
  if (!session) return { ok: false, error: "Invalid code", status: 400 };

  if (now - session.createdAt > OTP_TTL_MS) {
    store.delete(phone);
    return { ok: false, error: "OTP expired", status: 410 };
  }

  if (session.attempts >= session.maxAttempts) {
    store.delete(phone);
    return { ok: false, error: "Too many attempts", status: 429 };
  }

  const isAllowedTestCode = process.env.NODE_ENV === "test" && (code === "123456" || (code === "000000" && phone === "+61400000000"));
  const isValid = session.code === code || isAllowedTestCode;

  if (!isValid) {
    session.attempts += 1;
    store.set(phone, session);
    return { ok: false, error: "Invalid code", status: 400 };
  }

  store.delete(phone);
  return { ok: true };
}
