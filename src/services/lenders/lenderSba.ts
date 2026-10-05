// BF_SERVER_LENDER_SBA_IVES_v753
// "Do you offer SBA loans?" and, if yes, the lender's IVES details for IRS Form 4506-C. Read and saved
// through their own small endpoints (staff: /api/portal/lenders/:id/sba, lender: /api/lender/me/sba)
// so the long lender column lists stay as they are. The columns are lenders.offers_sba and the
// lenders.ives_* columns from v144, which loadIvesLenders reads when building the 4506-C.
import { pool } from "../../db.js";

export type LenderSba = {
  offersSba: boolean | null;
  ivesParticipantName: string;
  ivesParticipantId: string;
  ivesSorMailboxId: string;
  ivesStreet: string;
  ivesCity: string;
  ivesState: string;
  ivesZip: string;
};

const TEXT_FIELDS: Array<[keyof LenderSba, string]> = [
  ["ivesParticipantName", "ives_participant_name"],
  ["ivesParticipantId", "ives_participant_id"],
  ["ivesSorMailboxId", "ives_sor_mailbox_id"],
  ["ivesStreet", "ives_street"],
  ["ivesCity", "ives_city"],
  ["ivesState", "ives_state"],
  ["ivesZip", "ives_zip"],
];

type Q = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const defaultQ: Q = (sql, params) => pool.query(sql, params as any[]);

const text = (v: unknown, max = 120): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validates what a form sent. A lender that offers SBA must give the three fields line 5a of the 4506-C needs. */
export function parseLenderSba(body: any): { value: LenderSba; errors: string[] } {
  const raw = body?.offersSba ?? body?.offers_sba;
  const offersSba = raw === true || raw === "true" || raw === "yes" ? true : raw === false || raw === "false" || raw === "no" ? false : null;
  const value = { offersSba } as LenderSba;
  for (const [key, col] of TEXT_FIELDS) (value as any)[key] = text(body?.[key] ?? body?.[col]);
  const errors: string[] = [];
  if (offersSba === true) {
    if (!value.ivesParticipantName) errors.push("IVES participant name is required when the lender offers SBA loans.");
    if (!value.ivesParticipantId) errors.push("IVES participant ID is required when the lender offers SBA loans.");
    if (!value.ivesSorMailboxId) errors.push("SOR mailbox ID is required when the lender offers SBA loans.");
  }
  return { value, errors };
}

export async function readLenderSba(lenderId: string, q: Q = defaultQ): Promise<LenderSba | null> {
  const r = await q(
    `SELECT offers_sba, ives_participant_name, ives_participant_id, ives_sor_mailbox_id, ives_street, ives_city, ives_state, ives_zip
       FROM lenders WHERE id::text = ($1)::text LIMIT 1`,
    [lenderId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const out = { offersSba: row.offers_sba === null || row.offers_sba === undefined ? null : Boolean(row.offers_sba) } as LenderSba;
  for (const [key, col] of TEXT_FIELDS) (out as any)[key] = String(row[col] ?? "");
  return out;
}

/** Saves the answer and the IVES details. Answering "no" keeps the details on file but they stop being used. */
export async function saveLenderSba(lenderId: string, value: LenderSba, q: Q = defaultQ): Promise<LenderSba | null> {
  const cols = ["offers_sba", ...TEXT_FIELDS.map(([, col]) => col)];
  const params: unknown[] = [lenderId, value.offersSba, ...TEXT_FIELDS.map(([key]) => (value[key] as string) || null)];
  const sets = cols.map((col, i) => col + " = $" + (i + 2)).join(", ");
  const r = await q(`UPDATE lenders SET ${sets}, updated_at = now() WHERE id::text = ($1)::text RETURNING id`, params);
  if (!r.rows[0]) return null;
  return readLenderSba(lenderId, q);
}
