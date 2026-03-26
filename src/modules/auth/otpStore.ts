type OTPRecord = {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  used: boolean;
};

const store = new Map<string, OTPRecord>();
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_STORE_ITEMS = 1000;

export const otpStore = {
  set(phone: string, record: OTPRecord) {
    store.set(phone, record);
    setTimeout(() => store.delete(phone), OTP_TTL_MS).unref();
    if (store.size > MAX_OTP_STORE_ITEMS) {
      const firstKey = store.keys().next().value;
      if (firstKey) {
        store.delete(firstKey);
      }
    }
  },
  get(phone: string) {
    return store.get(phone);
  },
  delete(phone: string) {
    store.delete(phone);
  },
  clear() {
    store.clear();
  },
};

export type { OTPRecord };
