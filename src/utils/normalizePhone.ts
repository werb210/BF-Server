export function normalizePhone(input: string): string {
  if (!input) return input;

  const digits = input.replace(/[^\d]/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return input;
}
