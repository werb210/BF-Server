// BF_SERVER_US_SMS_TOLLFREE_v755
// US carriers block texts from unregistered 10-digit numbers (error 30034), and Boreal's local numbers are
// Canadian, which cannot be registered for US texting at all. So a text to a US number goes out from the
// 866 toll-free number, which is registered for exactly this use. Canadian (and other) numbers keep the
// local number. Override with TWILIO_US_SMS_FROM; set it to "off" to send everything from the local number.
// Not used for marketing or bulk sends: the toll-free registration promises transactional texts only.
export const DEFAULT_US_SMS_FROM = "+18666318939";

// Canadian area codes (NANP).
const CANADA = new Set(["204","226","236","249","250","257","263","289","306","343","354","365","367","368","382","387","403","416","418","428","431","437","438","450","460","468","474","506","514","519","548","579","581","584","587","600","604","613","622","633","639","644","647","655","672","677","683","688","705","709","742","753","778","780","782","807","819","825","867","873","879","902","905","942"]);
// Other NANP countries (Caribbean and Atlantic) - not the US.
const OTHER_NANP = new Set(["242","246","264","268","284","345","441","473","649","658","664","721","758","767","784","809","829","849","868","869","876"]);

/** True for a +1 number whose area code is in the United States (including US territories). */
export function isUsNumber(to: unknown): boolean {
  const digits = String(to ?? "").replace(/[^0-9]/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : "";
  if (!ten) return false;
  const area = ten.slice(0, 3);
  return !CANADA.has(area) && !OTHER_NANP.has(area);
}

/** The number to send from: the toll-free line for a US recipient, otherwise the usual number. */
export function smsFromFor<T extends string | undefined | null>(to: unknown, defaultFrom: T): string | T {
  if (!isUsNumber(to)) return defaultFrom;
  const configured = String(process.env.TWILIO_US_SMS_FROM ?? DEFAULT_US_SMS_FROM).trim();
  if (!configured || configured.toLowerCase() === "off") return defaultFrom;
  return configured;
}
