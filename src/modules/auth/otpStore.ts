type OTPRecord = {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  used: boolean;
};

const store = new Map<string, OTPRecord>();

export const otpStore = {
  set(phone: string, record: OTPRecord) {
    store.set(phone, record);
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
