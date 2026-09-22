// BF_SERVER_ADS_ENHANCED_v403
// Enhanced conversions for leads + automatic Customer Match upload.
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { accessToken } from "./googleAdsConversions.js";

const API = "https://googleads.googleapis.com/v24";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const digits = (value: unknown) => String(value ?? "").replace(/[^0-9]/g, "");

export function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

export function normalizePhone(phone: unknown): string {
  let normalized = digits(phone);
  if (normalized.length === 10) normalized = `1${normalized}`;
  return normalized.length >= 11 ? `+${normalized}` : "";
}

export function consentGiven(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase();
  return value === true || normalized === "true" || normalized === "yes";
}

export type UserIdentifier = { hashedEmail: string } | { hashedPhoneNumber: string };

export function userIdentifiersFor(email: unknown, phone: unknown, consent: unknown): UserIdentifier[] {
  if (!consentGiven(consent)) return [];
  const identifiers: UserIdentifier[] = [];
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail.includes("@")) identifiers.push({ hashedEmail: sha256(normalizedEmail) });
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) identifiers.push({ hashedPhoneNumber: sha256(normalizedPhone) });
  return identifiers;
}

export function customerMatchEnabled(): boolean {
  return String(process.env.GOOGLE_ADS_CUSTOMER_MATCH_ENABLED ?? "").toLowerCase() === "true"
    && Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CLIENT_ID
      && process.env.GOOGLE_ADS_CLIENT_SECRET && process.env.GOOGLE_ADS_REFRESH_TOKEN
      && process.env.GOOGLE_ADS_CUSTOMER_ID);
}

const LIST_KEY = "google_ads_customer_match_list";
const LAST_RUN_KEY = "google_ads_customer_match_last_run";
const WEEK_MS = 7 * 86_400_000;

async function headers(): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
  };
  const loginCustomerId = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (loginCustomerId) result["login-customer-id"] = loginCustomerId;
  return result;
}

async function call(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${API}/${path}`, {
    method: "POST", headers: await headers(), body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`google_ads ${path.split("/").pop()} ${response.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

async function getSetting(key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return result.rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Funded BF clients who have not opted out, as Google user identifiers (hashes only). */
export async function fundedClientIdentifiers(): Promise<UserIdentifier[][]> {
  const { rows } = await pool.query<{ email: string | null; phone: string | null }>(
    `SELECT DISTINCT c.email, c.phone
       FROM applications a JOIN contacts c ON c.id = a.contact_id
      WHERE a.silo = 'BF'
        AND a.pipeline_state IN ('Accepted', 'Funded')
        AND COALESCE(c.marketing_opt_out, false) = false
        AND (COALESCE(c.email, '') <> '' OR COALESCE(c.phone, '') <> '')`,
  );
  const seen = new Set<string>();
  const result: UserIdentifier[][] = [];
  for (const row of rows) {
    const identifiers = userIdentifiersFor(row.email, row.phone, true);
    if (!identifiers.length) continue;
    const key = JSON.stringify(identifiers);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identifiers);
  }
  return result;
}

export function customerMatchOperations(members: UserIdentifier[][]): unknown[] {
  return [{ removeAll: true }, ...members.map((userIdentifiers) => ({ create: { userIdentifiers } }))];
}

async function ensureList(customerId: string): Promise<string> {
  const existing = await getSetting(LIST_KEY);
  if (existing) return existing;
  const response = await call(`customers/${customerId}/userLists:mutate`, {
    operations: [{
      create: {
        name: "Boreal funded clients (auto)",
        description: "Funded Boreal Financial clients. Updated weekly by BF-Server.",
        membershipLifeSpan: 10000,
        crmBasedUserList: { uploadKeyType: "CONTACT_INFO", dataSourceType: "FIRST_PARTY" },
      },
    }],
  });
  const name = response?.results?.[0]?.resourceName;
  if (!name) throw new Error("google_ads userLists:mutate returned no list");
  await setSetting(LIST_KEY, String(name));
  return String(name);
}

/** Weekly full refresh of the Customer Match list. Returns what it did. */
export async function syncCustomerMatch(force = false): Promise<{ enabled: boolean; ran: boolean; members?: number; list?: string; error?: string }> {
  if (!customerMatchEnabled()) return { enabled: false, ran: false };
  const last = await getSetting(LAST_RUN_KEY);
  if (!force && last && Date.now() - Date.parse(last) < WEEK_MS) return { enabled: true, ran: false };
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  try {
    const list = await ensureList(customerId);
    const members = await fundedClientIdentifiers();
    const job = await call(`customers/${customerId}/offlineUserDataJobs:create`, {
      job: {
        type: "CUSTOMER_MATCH_USER_LIST",
        customerMatchUserListMetadata: {
          userList: list,
          consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" },
        },
      },
    });
    const jobName = String(job?.resourceName ?? "");
    if (!jobName) throw new Error("google_ads offlineUserDataJobs:create returned no job");
    const operations = customerMatchOperations(members);
    for (let index = 0; index < operations.length; index += 1000) {
      await call(`${jobName}:addOperations`, {
        operations: operations.slice(index, index + 1000), enablePartialFailure: true,
      });
    }
    await call(`${jobName}:run`, {});
    await setSetting(LAST_RUN_KEY, new Date().toISOString());
    console.log("[google_ads_customer_match] uploaded", JSON.stringify({ members: members.length, list }));
    return { enabled: true, ran: true, members: members.length, list };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[google_ads_customer_match] failed", message);
    return { enabled: true, ran: false, error: message };
  }
}
