type OTPRecord = {
  code: string;
  attempts: number;
};

const store = new Map<string, OTPRecord>();

export function setOTP(phone: string, code: string) {
  store.set(phone, { code, attempts: 0 });
}

export function getOTP(phone: string) {
  return store.get(phone);
}

export function deleteOTP(phone: string) {
  store.delete(phone);
}

export function clearOTPStore() {
  store.clear();
}

export type { OTPRecord };
