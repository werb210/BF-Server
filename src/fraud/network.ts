// BF_SERVER_v846_FRAUD - check 12: the fraud network. Applications are linked when they share a phone number, email,
// street address, bank account number (read from void cheques / statements), device, internet connection, or a
// director (same name AND date of birth). Labels are masked (last digits, first letter of the email) so the graph
// shows the shape of the network without spelling out personal details.
import type { Q } from "./types.js";
import type { AppProfile } from "./profile.js";
import { localHash, normDigits, normEmail, normName, normPhone } from "./hash.js";
import { normalizeDob } from "./checks/identity.js";
import type { Network, NetworkNode } from "./checks/misc.js";

export const MAX_LINKED_APPS = 25;

export function maskPhone(p: string): string { return `Phone ...${p.slice(-4)}`; }
export function maskEmail(e: string): string { const [l, d] = e.split("@"); return `Email ${l?.[0] ?? ""}***@${d ?? ""}`; }
export function maskAccount(a: string): string { return `Account ...${a.slice(-4)}`; }
export function streetKey(addr: string | null): string | null {
  const first = String(addr ?? "").split(",")[0] ?? "";
  const k = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  return k.length >= 6 && /\d/.test(k) ? k : null;
}

type Link = { type: NetworkNode["type"]; key: string; label: string; apps: Array<{ id: string; name: string | null; fraud: boolean }> };

export async function accountNumbersFor(db: Q, applicationId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT DISTINCT value FROM document_ocr_fields
      WHERE application_id = $1 AND field_key ILIKE '%account_number%' LIMIT 10`,
    [applicationId],
  );
  return r.rows.map((x: any) => normDigits(x.value, 5)).filter((x: string | null): x is string => Boolean(x));
}

const APP_COLS = `a.id::text AS id, COALESCE(a.business_legal_name, a.name) AS name,
  (a.pipeline_state = 'Fraud' OR a.fraud_confirmed_at IS NOT NULL) AS fraud`;

export async function buildNetwork(db: Q, p: AppProfile): Promise<Network> {
  const me = p.applicationId;
  const links: Link[] = [];
  const add = (type: Link["type"], key: string, label: string, rows: any[]) => {
    const apps = rows.filter((r) => r.id !== me).map((r) => ({ id: String(r.id), name: r.name ?? null, fraud: r.fraud === true }));
    if (apps.length) links.push({ type, key, label, apps });
  };

  for (const phone of [...new Set([normPhone(p.applicant.phone), normPhone(p.businessPhone)].filter((x): x is string => Boolean(x)))]) {
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM applications a
         LEFT JOIN application_contacts ac ON ac.application_id = a.id
         LEFT JOIN contacts c ON c.id = a.contact_id OR c.id = ac.contact_id
         LEFT JOIN companies co ON co.id = a.company_id
        WHERE a.id::text <> $2 AND (right(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(COALESCE(co.phone, ''), '\\D', '', 'g'), 10) = $1)
        LIMIT ${MAX_LINKED_APPS}`,
      [phone.slice(-10), me],
    );
    add("phone", `phone:${phone}`, maskPhone(phone), r.rows);
  }
  const email = normEmail(p.applicant.email);
  if (email) {
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM applications a
         LEFT JOIN application_contacts ac ON ac.application_id = a.id
         JOIN contacts c ON c.id = a.contact_id OR c.id = ac.contact_id
        WHERE a.id::text <> $2 AND lower(c.email) = $1 LIMIT ${MAX_LINKED_APPS}`,
      [String(p.applicant.email).trim().toLowerCase(), me],
    );
    add("email", `email:${email}`, maskEmail(email), r.rows);
  }
  const street = streetKey(p.businessAddress) ?? streetKey(p.applicant.address);
  if (street) {
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM applications a
         LEFT JOIN companies co ON co.id = a.company_id
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text <> $2 AND (lower(regexp_replace(COALESCE(co.address_street, ''), '[^a-zA-Z0-9]', '', 'g')) = $1
           OR lower(regexp_replace(COALESCE(c.address_street, ''), '[^a-zA-Z0-9]', '', 'g')) = $1)
        LIMIT ${MAX_LINKED_APPS}`,
      [street, me],
    );
    add("address", `address:${street}`, `Address ${street.replace(/^(\d+).*/, "$1")} ...`, r.rows);
  }
  for (const acct of await accountNumbersFor(db, me)) {
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM document_ocr_fields f JOIN applications a ON a.id::text = f.application_id
        WHERE f.application_id <> $2 AND f.field_key ILIKE '%account_number%' AND regexp_replace(f.value, '\\D', '', 'g') = $1
        LIMIT ${MAX_LINKED_APPS}`,
      [acct, me],
    );
    add("bank_account", `bank:${acct}`, maskAccount(acct), r.rows);
  }
  const dev = await db.query(`SELECT device_hash, ip_hash FROM fraud_device_signals WHERE application_id = $1`, [me]);
  const d = dev.rows[0];
  for (const [col, type, label] of [["device_hash", "device", "Same device"], ["ip_hash", "ip", "Same connection"]] as const) {
    const h = d?.[col];
    if (!h) continue;
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM fraud_device_signals s JOIN applications a ON a.id::text = s.application_id
        WHERE s.${col} = $1 AND s.application_id <> $2 LIMIT ${MAX_LINKED_APPS}`,
      [h, me],
    );
    add(type, `${type}:${String(h).slice(0, 12)}`, label, r.rows);
  }
  for (const o of [p.applicant, ...p.owners]) {
    const n = normName(o.name), dob = normalizeDob(o.dob);
    if (!n || !dob) continue;
    const r = await db.query(
      `SELECT DISTINCT ${APP_COLS} FROM applications a
         LEFT JOIN application_contacts ac ON ac.application_id = a.id
         JOIN contacts c ON c.id = a.contact_id OR c.id = ac.contact_id
        WHERE a.id::text <> $3 AND c.dob = $2::date
          AND lower(regexp_replace(COALESCE(c.name, concat_ws(' ', c.first_name, c.last_name)), '[^a-zA-Z ]', '', 'g')) = $1
        LIMIT ${MAX_LINKED_APPS}`,
      [n.replace(/[^a-z ]/g, ""), dob, me],
    );
    add("director", `director:${n}|${dob}`, `Director ${o.name?.split(" ")[0] ?? ""}`, r.rows);
  }

  const nodes = new Map<string, NetworkNode>();
  const edges: Network["edges"] = [];
  nodes.set(`app:${me}`, { id: `app:${me}`, type: "application", label: p.businessName ?? "This application", current: true, fraud: p.fraudConfirmed || p.pipelineState === "Fraud" });
  let appCount = 0;
  for (const l of links) {
    // Node ids carry a keyed hash, never the phone / email / account itself.
    const lid = `id:${l.type}:${(localHash("network-node", l.key) ?? l.type).slice(0, 16)}`;
    nodes.set(lid, { id: lid, type: l.type, label: l.label });
    edges.push({ from: `app:${me}`, to: lid });
    for (const a of l.apps) {
      const aid = `app:${a.id}`;
      if (!nodes.has(aid)) {
        if (appCount >= MAX_LINKED_APPS) continue;
        appCount++;
        nodes.set(aid, { id: aid, type: "application", label: a.name ?? "Application", fraud: a.fraud });
      }
      edges.push({ from: lid, to: aid });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

// BF_SERVER_v846_FRAUD - the network view shows linked files from the same silo only (BF / BI / SLF). The check itself
// (fraud_12) still counts links across silos; it reports counts, never which file.
/** Keeps only linked applications in the same silo (and the identifiers that still link to one). */
export async function sameSiloNetwork(q: Q, network: Network, silo: string | null): Promise<Network> {
  const appIds = network.nodes.filter((n) => n.type === "application" && !n.current).map((n) => n.id.replace(/^app:/, ""));
  if (!appIds.length || !silo) return network;
  const r = await q.query(`SELECT id::text AS id FROM applications WHERE id::text = ANY($1::text[]) AND (silo IS NULL OR upper(silo) = upper($2::text))`, [appIds, silo]);
  const keep = new Set(r.rows.map((x: any) => `app:${x.id}`));
  const apps = network.nodes.filter((n) => n.type !== "application" || n.current || keep.has(n.id));
  const appSet = new Set(apps.filter((n) => n.type === "application").map((n) => n.id));
  const edges = network.edges.filter((e) => !(e.to.startsWith("app:") && !appSet.has(e.to)));
  const linked = new Set(edges.filter((e) => e.to.startsWith("app:")).map((e) => e.from));
  const nodes = apps.filter((n) => n.type === "application" || linked.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)) };
}
