// BF_SERVER_v829_DIALER_RELIABILITY - who answered an inbound call, and finding a call from the CallSid the dialler
// holds.
//
// An inbound call is logged once, up front (routes/webhooks.ts), under the caller's CallSid with no staff member. The
// staff phone answers a separate leg (<Dial><Client>, or a ring-all leg into a conference) with its own CallSid, and
// that is the only sid the iPhone dialler knows. So "save the call outcome" (POST /telephony/calls/:sid/disposition)
// never found the row: wrong sid, and no staff member on it. Two fixes:
//   1. claimInboundCall: when a staff leg is answered, stamp the call_logs row with that staff member and that leg's
//      CallSid (answered_leg_sid).
//   2. findCallForStaff: resolve the dialler's sid by the logged sid, by answered_leg_sid, or - for calls answered
//      before this change - through the conference / call record the leg was part of.

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The staff user behind a Twilio client identity (the identity is the user id, or staff_presence.twilio_identity). */
export async function staffUserForIdentity(q: Q, identity: string | null | undefined): Promise<string | null> {
  const raw = String(identity ?? "").trim().replace(/^client:/, "");
  if (!raw) return null;
  if (UUID_RE.test(raw)) return raw;
  const r = await q.query(`SELECT user_id::text AS user_id FROM staff_presence WHERE twilio_identity = $1 LIMIT 1`, [raw]);
  return r.rows[0]?.user_id ?? null;
}

/**
 * Stamps the inbound call_logs row (logged under the caller's CallSid) with the staff member who answered and the
 * CallSid of their leg. First answer wins; never overwrites. Returns true when a row was stamped. Never throws.
 */
export async function claimInboundCall(q: Q, args: { parentCallSid: string | null | undefined; answeredLegSid: string | null | undefined; identity?: string | null; staffUserId?: string | null }): Promise<boolean> {
  const parent = String(args.parentCallSid ?? "").trim();
  const leg = String(args.answeredLegSid ?? "").trim();
  if (!parent || !leg) return false;
  try {
    const userId = args.staffUserId ?? await staffUserForIdentity(q, args.identity);
    const r = await q.query(
      `UPDATE call_logs
          SET staff_user_id = COALESCE(staff_user_id, $3::uuid),
              answered_leg_sid = COALESCE(answered_leg_sid, $2),
              answered = true,
              updated_at = now()
        WHERE twilio_call_sid = $1
          AND (answered_leg_sid IS NULL OR answered_leg_sid = $2)
        RETURNING id`,
      [parent, leg, userId],
    );
    return (r.rowCount ?? r.rows.length) > 0;
  } catch (err: any) {
    console.warn("[call-attribution] claim failed", { parent, leg, message: err?.message });
    return false;
  }
}

/** The caller's CallSid for a recorded-dial call record ("rx_<CallSid>"), else null. */
export function parentSidFromRecordName(friendlyName: string | null | undefined): string | null {
  const m = /^rx_(CA[0-9a-f]{32})$/i.exec(String(friendlyName ?? "").trim());
  return m ? m[1]! : null;
}

/**
 * The call_logs row (id, contact, silo) a staff member may record an outcome on, from our call id or any CallSid the
 * dialler may hold: the logged sid, the answering leg's sid, or a leg in the same conference / call record as a
 * logged call. A row with no staff member yet is claimed for the caller's own leg only.
 */
export async function findCallForStaff(q: Q, ref: { kind: "id" | "sid"; value: string }, staffUserId: string): Promise<{ id: string; contactId: string | null; silo: string | null } | null> {
  if (ref.kind === "id") {
    const r = await q.query(
      `SELECT id::text AS id, COALESCE(contact_id, crm_contact_id)::text AS contact_id, silo
         FROM call_logs WHERE id = $1::uuid AND staff_user_id::text = $2::text LIMIT 1`,
      [ref.value, staffUserId],
    );
    const row = r.rows[0];
    return row ? { id: row.id, contactId: row.contact_id ?? null, silo: row.silo ?? null } : null;
  }
  const r = await q.query(
    `WITH my_identities AS (
       SELECT $2::text AS identity
       UNION SELECT twilio_identity FROM staff_presence WHERE user_id::text = $2::text AND twilio_identity IS NOT NULL
     ),
     my_leg AS (
       SELECT p.conference_id FROM conference_participants p
        WHERE p.twilio_call_sid = $1::text AND p.kind = 'staff' AND p.identity IN (SELECT identity FROM my_identities)
     ),
     sibling_sids AS (
       SELECT p.twilio_call_sid AS sid FROM conference_participants p
        WHERE p.conference_id IN (SELECT conference_id FROM my_leg) AND p.twilio_call_sid IS NOT NULL
     )
     SELECT id::text AS id, COALESCE(contact_id, crm_contact_id)::text AS contact_id, silo, staff_user_id::text AS staff_user_id
       FROM call_logs
      WHERE (twilio_call_sid = $1::text OR answered_leg_sid = $1::text OR twilio_call_sid IN (SELECT sid FROM sibling_sids))
        AND (staff_user_id::text = $2::text
             OR (staff_user_id IS NULL AND (answered_leg_sid = $1::text OR twilio_call_sid IN (SELECT sid FROM sibling_sids))))
      ORDER BY (twilio_call_sid = $1::text OR answered_leg_sid = $1::text) DESC, created_at DESC
      LIMIT 1`,
    [ref.value, staffUserId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!row.staff_user_id) {
    await q.query(
      `UPDATE call_logs SET staff_user_id = $2::uuid, answered_leg_sid = COALESCE(answered_leg_sid, $3), updated_at = now()
        WHERE id = $1::uuid AND staff_user_id IS NULL`,
      [row.id, staffUserId, ref.value],
    );
  }
  return { id: row.id, contactId: row.contact_id ?? null, silo: row.silo ?? null };
}
