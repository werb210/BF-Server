const store: Record<string, { code: string; createdAt: number }> = {};

export function setOtp(phone: string, code: string) {
  store[phone] = {
    code,
    createdAt: Date.now(),
  };
}

export function getOtp(phone: string) {
  return store[phone];
}

export function clearOtp(phone: string) {
  delete store[phone];
}
