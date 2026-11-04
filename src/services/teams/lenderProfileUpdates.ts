// BF_SERVER_v890_MAYA_LENDER_UPDATES
// After a Teams meeting with a lender, Maya proposes changes to that lender's profile (contact details, notes,
// product amounts, rates, terms, commission, minimum credit score). Nothing is written until a staff member approves
// one proposal. Each proposal is stored on teams_meetings.maya_profile_updates:
//   { id, target: "lender" | "product", product_id, product_name, field, label, current, proposed, reason, status,
//     decided_by, decided_at }
// status is proposed | approved | rejected | stale (the value changed since Maya read it).
import type { Pool } from "pg";

type FieldKind = "text" | "money" | "rate" | "int" | "percent";
type FieldSpec = { label: string; kind: FieldKind };

export const LENDER_FIELDS: Record<string, FieldSpec> = {
  description: { label: "Description", kind: "text" },
  internal_notes: { label: "Internal notes", kind: "text" },
  announcement: { label: "Announcement", kind: "text" },
  primary_contact_name: { label: "Main contact name", kind: "text" },
  primary_contact_email: { label: "Main contact email", kind: "text" },
  primary_contact_phone: { label: "Main contact phone", kind: "text" },
};

export const PRODUCT_FIELDS: Record<string, FieldSpec> = {
  amount_min: { label: "Minimum amount", kind: "money" },
  amount_max: { label: "Maximum amount", kind: "money" },
  rate_min_num: { label: "Lowest rate", kind: "rate" },
  rate_max_num: { label: "Highest rate", kind: "rate" },
  term_min: { label: "Shortest term", kind: "int" },
  term_max: { label: "Longest term", kind: "int" },
  commission: { label: "Commission (%)", kind: "percent" },
  min_credit_score: { label: "Minimum credit score", kind: "int" },
  eligibility_notes: { label: "Eligibility notes", kind: "text" },
};

const MAX_UPDATES = 8;

export type LenderSnapshot = {
  lender: { id: string; name: string; silo: string | null } & Record<string, unknown>;
  products: Array<{ id: string; name: string; category: string | null } & Record<string, unknown>>;
};

export type ProfileUpdate = {
  id: string;
  target: "lender" | "product";
  product_id: string | null;
  product_name: string | null;
  field: string;
  label: string;
  current: string | number | null;
  proposed: string | number;
  reason: string;
  status: "proposed" | "approved" | "rejected" | "stale";
  decided_by?: string | null;
  decided_at?: string | null;
};

/** The lender a meeting is about: its own lender_id, else the lender of its company, else of its contact's company. */
export async function meetingLenderId(
  pool: Pool,
  m: { lender_id?: string | null; company_id?: string | null; contact_id?: string | null },
): Promise<string | null> {
  if (m.lender_id) return m.lender_id;
  if (!m.company_id && !m.contact_id) return null;
  const { rows } = await pool.query<{ lender_id: string | null }>(
    `SELECT COALESCE(
              (SELECT c.lender_id::text FROM companies c WHERE c.id = $1::uuid),
              (SELECT c.lender_id::text FROM contacts ct JOIN companies c ON c.id = ct.company_id WHERE ct.id = $2::uuid)
            ) AS lender_id`,
    [m.company_id ?? null, m.contact_id ?? null],
  );
  return rows[0]?.lender_id ?? null;
}

export async function loadLenderSnapshot(pool: Pool, lenderId: string): Promise<LenderSnapshot | null> {
  const lender = await pool.query(
    `SELECT id::text AS id, name, silo, ${Object.keys(LENDER_FIELDS).join(", ")} FROM lenders WHERE id = $1::uuid`,
    [lenderId],
  );
  if (!lender.rows[0]) return null;
  const products = await pool.query(
    `SELECT id::text AS id, name, category, ${Object.keys(PRODUCT_FIELDS).join(", ")}
       FROM lender_products
      WHERE lender_id = $1::uuid AND active IS TRUE
      ORDER BY name
      LIMIT 40`,
    [lenderId],
  );
  return { lender: lender.rows[0], products: products.rows };
}

/** The part of Maya's instructions that describes the lender and the fields she may propose. */
export function lenderPromptSection(s: LenderSnapshot): string {
  const lenderLines = Object.keys(LENDER_FIELDS).map((f) => `  ${f}: ${short(s.lender[f])}`);
  const productLines = s.products.map((p) =>
    `  - product_id ${p.id} "${p.name}" (${p.category ?? "?"}): ` +
    Object.keys(PRODUCT_FIELDS).map((f) => `${f}=${short(p[f])}`).join(", "),
  );
  return [
    `This meeting was with the lender "${s.lender.name}". Its current profile:`,
    ...lenderLines,
    "Its products:",
    ...(productLines.length ? productLines : ["  (none)"]),
    "",
    'Also return "profile_updates": changes to this profile that the lender clearly stated in the meeting ' +
      "(a new minimum or maximum, a rate or commission change, a new contact, appetite or industries they will or will not fund). " +
      'Each item: {"target":"lender" or "product","product_id":"<id above, product only>","field":"<one field name above>",' +
      '"proposed":<new value>,"reason":"what was said, one line"}. ' +
      "Money is a plain number of dollars, rates and commission are percentages as numbers, terms are months. " +
      "Appetite and industry changes go in internal_notes (lender) or eligibility_notes (product) as one short sentence to add. " +
      "Only propose what the lender said. If nothing changed, return an empty array.",
  ].join("\n");
}

function short(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  const t = String(v).replace(/\s+/g, " ");
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}

function coerce(kind: FieldKind, raw: unknown): string | number | null {
  if (kind === "text") {
    const t = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    return t ? t.slice(0, 2000) : null;
  }
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  if (kind === "money") return Math.round(n);
  if (kind === "int") return Math.round(n);
  if (kind === "percent") return n > 100 ? null : Math.round(n * 1000) / 1000;
  return n > 1000 ? null : Math.round(n * 1000) / 1000; // rate
}

/** Validates Maya's proposals against the snapshot: known fields only, real product ids, an actual change. */
export function cleanProfileUpdates(raw: unknown, s: LenderSnapshot): ProfileUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileUpdate[] = [];
  for (const item of raw) {
    if (out.length >= MAX_UPDATES) break;
    const target = item?.target === "product" ? "product" : item?.target === "lender" ? "lender" : null;
    const field = typeof item?.field === "string" ? item.field.trim() : "";
    if (!target || !field) continue;
    const spec = target === "lender" ? LENDER_FIELDS[field] : PRODUCT_FIELDS[field];
    if (!spec) continue;
    let product: LenderSnapshot["products"][number] | undefined;
    if (target === "product") {
      product = s.products.find((p) => p.id === String(item?.product_id ?? ""));
      if (!product) continue;
    }
    const proposed = coerce(spec.kind, item?.proposed);
    if (proposed === null) continue;
    const currentRaw = (target === "lender" ? s.lender[field] : product![field]) as unknown;
    const current = currentRaw === null || currentRaw === undefined || currentRaw === "" ? null
      : spec.kind === "text" ? String(currentRaw) : Number(currentRaw);
    if (current !== null && String(current) === String(proposed)) continue;
    if (spec.kind === "text" && current !== null && String(current).includes(String(proposed))) continue;
    out.push({
      id: `u${out.length + 1}`,
      target,
      product_id: product?.id ?? null,
      product_name: product?.name ?? null,
      field,
      label: spec.label,
      current,
      proposed,
      reason: typeof item?.reason === "string" ? item.reason.trim().slice(0, 300) : "",
      status: "proposed",
    });
  }
  return out;
}

const NOTE_FIELDS = new Set(["internal_notes", "eligibility_notes"]);

export class UpdateError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

/**
 * Approves or rejects one proposal. Approving writes the value (notes fields get the sentence added on a new line,
 * dated) unless the stored value changed since Maya read it, in which case the proposal is marked stale and nothing
 * is written. Rejecting only records the decision.
 */
export async function decideProfileUpdate(
  pool: Pool,
  args: { meetingId: string; updateId: string; decision: "approve" | "reject"; userId: string | null; silo: string | null },
): Promise<ProfileUpdate> {
  const client = await (pool as any).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT tm.id::text AS id, tm.silo, tm.lender_id::text AS lender_id, tm.company_id::text AS company_id,
              tm.contact_id::text AS contact_id, tm.maya_profile_updates AS updates
         FROM teams_meetings tm WHERE tm.id = $1::uuid FOR UPDATE`,
      [args.meetingId],
    );
    const m = rows[0];
    if (!m || (args.silo && m.silo && m.silo !== args.silo)) throw new UpdateError("not_found", 404, "Meeting not found.");
    const updates: ProfileUpdate[] = Array.isArray(m.updates) ? m.updates : [];
    const u = updates.find((x) => x.id === args.updateId);
    if (!u) throw new UpdateError("not_found", 404, "That proposed change was not found.");
    if (u.status !== "proposed") throw new UpdateError("already_decided", 409, "That change was already decided.");

    if (args.decision === "approve") {
      const lenderId = await meetingLenderId(client, m);
      if (!lenderId) throw new UpdateError("no_lender", 409, "This meeting is not linked to a lender.");
      const spec = u.target === "lender" ? LENDER_FIELDS[u.field] : PRODUCT_FIELDS[u.field];
      if (!spec) throw new UpdateError("bad_field", 400, "That field cannot be changed from a meeting.");
      const table = u.target === "lender" ? "lenders" : "lender_products";
      const isLender = u.target === "lender";
      const key = isLender ? lenderId : u.product_id;
      const cur = await client.query(
        `SELECT ${u.field} AS v FROM ${table} WHERE ${isLender ? "id = $1::uuid" : "id = $1 AND lender_id = $2::uuid"} FOR UPDATE`,
        isLender ? [key] : [key, lenderId],
      );
      if (!cur.rows[0]) throw new UpdateError("not_found", 404, "The lender or product no longer exists.");
      const now = cur.rows[0].v;
      const nowNorm = now === null || now === undefined || now === "" ? null : spec.kind === "text" ? String(now) : Number(now);
      if (String(nowNorm) !== String(u.current)) {
        u.status = "stale";
      } else {
        let value: string | number = u.proposed;
        if (NOTE_FIELDS.has(u.field)) {
          const stamp = new Date().toISOString().slice(0, 10);
          value = [nowNorm ? String(nowNorm) : "", `${stamp} (meeting): ${u.proposed}`].filter(Boolean).join("\n");
        }
        await client.query(
          `UPDATE ${table} SET ${u.field} = $2, updated_at = now() WHERE ${isLender ? "id = $1::uuid" : "id = $1 AND lender_id = $3::uuid"}`,
          isLender ? [key, value] : [key, value, lenderId],
        );
        u.status = "approved";
      }
    } else {
      u.status = "rejected";
    }
    u.decided_by = args.userId;
    u.decided_at = new Date().toISOString();
    await client.query(
      `UPDATE teams_meetings SET maya_profile_updates = $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
      [args.meetingId, JSON.stringify(updates)],
    );
    await client.query("COMMIT");
    return u;
  } catch (err) {
    await client.query("ROLLBACK").catch((e: any) => console.error("[lender-updates] rollback failed", e?.message));
    throw err;
  } finally {
    client.release();
  }
}

/** Open proposals for one lender, newest meeting first. */
export async function listLenderProposals(pool: Pool, lenderId: string, silo: string | null) {
  const { rows } = await pool.query(
    `SELECT tm.id::text AS meeting_id, tm.subject, COALESCE(tm.ended_at, tm.scheduled_at) AS meeting_at,
            tm.maya_profile_updates AS updates
       FROM teams_meetings tm
       LEFT JOIN companies c ON c.id = tm.company_id
       LEFT JOIN contacts ct ON ct.id = tm.contact_id
       LEFT JOIN companies cc ON cc.id = ct.company_id
      WHERE COALESCE(tm.lender_id, c.lender_id, cc.lender_id) = $1::uuid
        AND ($2::text IS NULL OR tm.silo = $2)
        AND jsonb_array_length(tm.maya_profile_updates) > 0
      ORDER BY COALESCE(tm.ended_at, tm.scheduled_at) DESC NULLS LAST
      LIMIT 50`,
    [lenderId, silo],
  );
  return rows
    .map((r: any) => ({
      meeting_id: r.meeting_id,
      subject: r.subject,
      meeting_at: r.meeting_at,
      updates: (Array.isArray(r.updates) ? r.updates : []).filter((u: ProfileUpdate) => u.status === "proposed"),
    }))
    .filter((r: any) => r.updates.length > 0);
}
