export function normalizePhone(phone: string): string {
  if (!phone || phone.length < 10) {
    throw new Error("Invalid phone number");
  }
  return phone;
}
