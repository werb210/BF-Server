// BF_SERVER_v909_AVAILABLE_NUMBERS - the Twilio numbers on Boreal's account that no staff member has as a direct line
// and that are not the main / SMS lines, for Settings > Team & roles > Add user ("Assign a direct phone number").
import { e164 } from "./directLines.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export type TwilioNumber = { phoneNumber: string; friendlyName?: string | null };
export type ListNumbers = () => Promise<TwilioNumber[]>;

const MAIN_LINE_ENVS = ["TWILIO_MAIN_LINE_NUMBER", "TWILIO_FROM_NUMBER", "TWILIO_PHONE", "TWILIO_PHONE_NUMBER", "TWILIO_SMS_FROM", "TWILIO_FROM", "TWILIO_US_SMS_FROM", "TWILIO_NUMBER"];

export function mainLines(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const k of MAIN_LINE_ENVS) {
    for (const part of String(env[k] ?? "").split(/[,;]+/)) {
      const n = e164(part);
      if (n) out.add(n);
    }
  }
  return out;
}

export async function availableNumbers(db: Q, list: ListNumbers, env: NodeJS.ProcessEnv = process.env): Promise<Array<{ number: string; label: string | null }>> {
  const taken = new Set((await db.query(`SELECT direct_number FROM users WHERE direct_number IS NOT NULL`)).rows.map((r: any) => e164(r.direct_number)).filter(Boolean) as string[]);
  const main = mainLines(env);
  const seen = new Set<string>();
  const out: Array<{ number: string; label: string | null }> = [];
  for (const n of await list()) {
    const num = e164(n.phoneNumber);
    if (!num || taken.has(num) || main.has(num) || seen.has(num)) continue;
    seen.add(num);
    out.push({ number: num, label: n.friendlyName && n.friendlyName !== n.phoneNumber ? n.friendlyName : null });
  }
  return out.sort((a, b) => a.number.localeCompare(b.number));
}
