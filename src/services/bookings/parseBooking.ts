// BF_SERVER_BOOKINGS_TO_CRM_v1
// Microsoft Bookings writes a structured "Customer Info" block into the event body. It is
// the only place the prospect's details exist - the Graph attendee list contains the
// BOOKING MAILBOX and the staff member, not the customer - so this block IS the lead.
//
// Real example (Michael Cotic, 2026-07-13):
//   Customer Info ------------------- Name: MICHAEL COTIC Email: ffxinc@gmail.com
//   Phone Number: 19055698018 Address: 3450 RIDGEWAY DRIVE UNIT 17
//   Time Zone: Mountain Standard Time Notes: WORKING CAPITAL LOANS
//   Booking Info ------------------- Service name: 30 minute Phone Call
export type ParsedBooking = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  customerNotes: string;
  serviceName: string;
};

function toPlainText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const LABELS = [
  "Name", "Email", "Phone Number", "Address", "Time Zone", "Notes",
  "Additional Recipients", "Service name", "Booking Info",
  "Additional Information", "Customer Info", "Staff", "Location",
];

function esc(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECTIONS = ["Customer Info", "Booking Info", "Additional Information"];

function field(text: string, label: string): string {
  const others = LABELS.filter((l) => l !== label).map(esc).join("|");
  const sections = SECTIONS.filter((l) => l !== label).map(esc).join("|");
  const re = new RegExp(
    `${esc(label)}\\s*:\\s*(.*?)(?=\\s*(?:${others})\\s*:|\\s*(?:${sections})\\b|\\s*-{3,}|$)`,
    "is",
  );
  const m = re.exec(text);
  return m?.[1] ? m[1].replace(/-{3,}/g, "").trim() : "";
}

export function isBookingBody(html: string | null | undefined): boolean {
  const t = toPlainText(html ?? "");
  return /Customer Info/i.test(t) && /Name\s*:/i.test(t);
}

export function parseBooking(html: string | null | undefined): ParsedBooking | null {
  const text = toPlainText(html ?? "");
  if (!isBookingBody(html)) return null;

  const customerName = field(text, "Name");
  const customerEmail = field(text, "Email");
  const customerPhone = field(text, "Phone Number");
  if (!customerName && !customerEmail && !customerPhone) return null;

  return {
    customerName,
    customerEmail,
    customerPhone,
    customerAddress: field(text, "Address"),
    customerNotes: field(text, "Notes"),
    serviceName: field(text, "Service name"),
  };
}

export function toE164(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
