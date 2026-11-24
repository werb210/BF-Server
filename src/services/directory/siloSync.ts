// BF_SHARED_CONTACTS_STAGE2_v1 (2026-11-24) - the shared contact list also reads what each silo already holds, so the
// broker, lender and bank lists loaded before it existed are in it, and each person's state in each brand stays current
// (opted out there, a prospect, a customer). It only reads the silos and only writes the shared list: nothing is pushed
// to a silo and nobody is emailed.
//   - Boreal Risk Management: BI-Server's CRM directory export, with a service token. Runs on its own every night.
//   - Keystone: KS-Ops' prospect export. KS-Ops only takes staff, so this part runs when a staff member asks for a sync.
import type { Pool, PoolClient } from "pg";
import { signServiceToken } from "../../auth/serviceTokens.js";
import { claimedTick } from "../../workers/claim.js";
import { cleanEmail, countryCode, domainOf, type Brand, type Kind, type Row, upsertOrg, upsertPerson } from "./sharedContacts.js";

type Q = Pick<Pool | PoolClient, "query">;
export type SyncFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export type SyncDeps = { fetch: SyncFetch; biUrl: string; ksOpsUrl: string; staffToken: string | null };
export type SyncResult = { brand: Brand; read: number; people_added: number; skipped: number; error?: string };

const MAX_PAGES = 200;
const PAGE = 1000;

export type SiloPerson = {
  silo_id: string; name: string | null; email: string | null; phone: string | null; title: string | null;
  company: string | null; website: string | null; country: string | null; region: string | null; city: string | null;
  kind: Kind; opted_out: boolean; activity: string | null;
};

const s = (v: unknown, max = 300) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
const kindOf = (v: unknown): Kind => (v === "broker" || v === "bank" ? v : "lender");

export function fromBi(x: any): SiloPerson {
  return {
    silo_id: String(x.id), name: s(x.full_name, 200), email: cleanEmail(x.email), phone: s(x.phone_e164, 40), title: s(x.title, 200),
    company: s(x.company, 200), website: s(x.website), country: countryCode(x.country), region: s(x.state, 60), city: s(x.city, 120),
    kind: kindOf(x.kind), opted_out: x.opted_out === true, activity: s(x.outreach_status, 60),
  };
}

export function fromKs(x: any): SiloPerson {
  return {
    silo_id: String(x.id), name: s(x.name, 200), email: cleanEmail(x.email), phone: s(x.phone, 40), title: s(x.title, 200),
    company: s(x.company, 200), website: null, country: countryCode(x.country), region: s(x.province_state, 60), city: null,
    kind: "broker", opted_out: x.opted_out === true, activity: s(x.status, 60),
  };
}

/** One silo person into the shared list, with that brand's state. People without an email are skipped (the list is keyed
 *  by email; a silo record with no email can't be matched across brands). */
export async function absorb(db: Q, brand: Brand, p: SiloPerson, source: string): Promise<"added" | "updated" | "skipped"> {
  if (!p.email) return "skipped";
  const domain = domainOf(p.website, p.email);
  const company = p.company ?? domain;
  const row: Row = {
    company: company ?? "", domain, website: p.website, kind: p.kind, country: p.country, region: p.region, city: p.city,
    phone: null, address: null, research: {}, person: { name: p.name, email: p.email, phone: p.phone, title: p.title, research: {} },
  };
  const orgId = company ? await upsertOrg(db, row, source) : (null as unknown as string);
  const person = await upsertPerson(db, orgId, row, source);
  // The silo's own state wins: opted out there means opted out for that brand; an opt-out recorded here is never undone.
  await db.query(
    `INSERT INTO directory_brand_status (person_id, brand, status, silo_record_id, last_activity, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (person_id, brand) DO UPDATE SET
       status = CASE WHEN directory_brand_status.status = 'opted_out' OR EXCLUDED.status = 'opted_out' THEN 'opted_out'
                     ELSE directory_brand_status.status END,
       silo_record_id = coalesce(EXCLUDED.silo_record_id, directory_brand_status.silo_record_id),
       last_activity = coalesce(EXCLUDED.last_activity, directory_brand_status.last_activity),
       last_activity_at = CASE WHEN EXCLUDED.last_activity IS DISTINCT FROM directory_brand_status.last_activity THEN now()
                               ELSE directory_brand_status.last_activity_at END,
       updated_at = now()`,
    [person.id, brand, p.opted_out ? "opted_out" : "loaded", p.silo_id, p.activity],
  );
  return person.created ? "added" : "updated";
}

async function pages(fetchPage: (after: string | null) => Promise<{ items: any[]; next: string | null }>, each: (x: any) => Promise<void>) {
  let after: string | null = null, n = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { items, next } = await fetchPage(after);
    for (const x of items) { await each(x); n++; }
    if (!next || !items.length) break;
    after = next;
  }
  return n;
}

export async function syncBi(db: Q, deps: SyncDeps): Promise<SyncResult> {
  const out: SyncResult = { brand: "BI", read: 0, people_added: 0, skipped: 0 };
  const base = deps.biUrl.replace(/\/+$/, "");
  const auth = `Bearer ${signServiceToken("bi-server", { source: "bf-server" })}`;
  out.read = await pages(async (after) => {
    const r = await deps.fetch(`${base}/api/v1/bi/crm/directory-export?limit=${PAGE}${after ? `&after=${after}` : ""}`, { method: "GET", headers: { authorization: auth } });
    if (!r.ok) throw new Error(`BI directory export answered ${r.status}`);
    const j = await r.json();
    return { items: Array.isArray(j?.items) ? j.items : [], next: j?.next ?? null };
  }, async (x) => {
    const res = await absorb(db, "BI", fromBi(x), "BI CRM");
    if (res === "added") out.people_added++; else if (res === "skipped") out.skipped++;
  });
  return out;
}

export async function syncKs(db: Q, deps: SyncDeps): Promise<SyncResult> {
  const out: SyncResult = { brand: "KS", read: 0, people_added: 0, skipped: 0 };
  if (!deps.staffToken) return { ...out, error: "Keystone syncs when a staff member asks for it (KS-Ops only takes staff)." };
  const base = deps.ksOpsUrl.replace(/\/+$/, "");
  const ex = await deps.fetch(`${base}/api/ops/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bfToken: deps.staffToken }) });
  const exBody = await ex.json().catch(() => null);
  const token = exBody?.token ?? exBody?.accessToken;
  if (!ex.ok || !token) throw new Error(`KS-Ops sign-in answered ${ex.status}`);
  out.read = await pages(async (after) => {
    const r = await deps.fetch(`${base}/api/ops/outreach/directory-export?limit=${PAGE}${after ? `&after=${after}` : ""}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`KS-Ops directory export answered ${r.status}`);
    const j = await r.json();
    return { items: Array.isArray(j?.items) ? j.items : [], next: j?.next ?? null };
  }, async (x) => {
    const res = await absorb(db, "KS", fromKs(x), "Keystone prospects");
    if (res === "added") out.people_added++; else if (res === "skipped") out.skipped++;
  });
  return out;
}

/** Both silos; a failure in one is recorded and the other still runs. The run is logged in directory_imports. */
export async function syncFromSilos(db: Q, deps: SyncDeps, by: string) {
  const results: SyncResult[] = [];
  for (const [brand, fn] of [["BI", syncBi], ["KS", syncKs]] as const) {
    try { results.push(await fn(db, deps)); }
    catch (err) { results.push({ brand, read: 0, people_added: 0, skipped: 0, error: err instanceof Error ? err.message : String(err) }); }
  }
  const read = results.reduce((n, r) => n + r.read, 0);
  await db.query(
    `INSERT INTO directory_imports (list_name, kind, row_count, routing, result, created_by) VALUES ($1, 'sync', $2, '{}'::jsonb, $3::jsonb, $4)`,
    ["Sync from silos", read, JSON.stringify({ results }), by],
  );
  return { results };
}

/** Hours since the last silo sync (Infinity when there has never been one). */
export async function hoursSinceLastSync(db: Q): Promise<number> {
  const r = await db.query(`SELECT max(created_at) AS at FROM directory_imports WHERE kind = 'sync'`);
  const at = r.rows[0]?.at ? new Date(r.rows[0].at).getTime() : NaN;
  return Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : Infinity;
}

/** Every hour; reads the silos when the last sync is 20 hours old (so about once a night, whichever instance claims it). */
export function startSharedContactsSyncWorker(db: Q): { stop: () => void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      if ((await hoursSinceLastSync(db)) < 20) return;
      const r = await syncFromSilos(db, {
        fetch: (url, init) => fetch(url, init) as any,
        biUrl: process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net",
        ksOpsUrl: process.env.KS_OPS_URL || "https://ops.keystonecrm.online",
        staffToken: null,
      }, "nightly");
      console.log("[shared-contacts-sync] done", JSON.stringify(r.results));
    } catch (err) {
      console.warn("[shared-contacts-sync] failed", err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("shared_contacts_sync", run);
  const first = setTimeout(() => { void tick(); }, 10 * 60_000);
  const timer = setInterval(() => { void tick(); }, 60 * 60_000);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
