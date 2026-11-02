// BF_SERVER_v864_ACTIVE_CONTRACTS - contract activity goes on the CRM Timeline (crm_timeline_events, event_type
// 'contract_activity'); it is not kept in a second timeline. The contract's "Recent activity" reads the same rows.
// Each event carries the contract id (and the renewal opportunity / application where there is one) so the
// portal's Timeline row can open the contract.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type ContractEvent = { title: string; detail?: string | null; opportunityId?: string | null; applicationId?: string | null; actor?: string | null; channel?: string | null };

export async function writeContractEvent(db: Q, contractId: string, e: ContractEvent): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT COALESCE(c.contact_id,
                       (SELECT x.id FROM contacts x WHERE x.company_id = c.company_id AND x.merged_into_id IS NULL ORDER BY x.created_at ASC LIMIT 1))::text AS contact_id,
              c.application_id
         FROM active_contracts c WHERE c.id = $1::uuid`, [contractId]);
    const contactId = r.rows[0]?.contact_id ?? null;
    if (!contactId) {
      console.warn("[active-contracts] timeline event not written: the contract has no contact", { contractId, title: e.title });
      return false;
    }
    await db.query(
      `INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload, actor_user_id)
       VALUES ($1::uuid, $2, 'contract_activity', $3::jsonb, $4::uuid)`,
      [contactId, e.applicationId ?? r.rows[0]?.application_id ?? null,
        JSON.stringify({ contract_id: contractId, opportunity_id: e.opportunityId ?? null, title: e.title.slice(0, 200), detail: (e.detail ?? "").slice(0, 2000), channel: e.channel ?? null }),
        e.actor ?? null]);
    return true;
  } catch (err) {
    console.warn("[active-contracts] timeline event failed", { contractId, title: e.title, message: (err as Error)?.message });
    return false;
  }
}

export async function contractActivity(db: Q, contractId: string, limit = 25): Promise<any[]> {
  try {
    const r = await db.query(
      `SELECT id::text AS id, created_at, payload->>'title' AS title, payload->>'detail' AS detail, payload->>'channel' AS channel,
              payload->>'opportunity_id' AS opportunity_id
         FROM crm_timeline_events
        WHERE event_type = 'contract_activity' AND payload->>'contract_id' = $1
        ORDER BY created_at DESC LIMIT $2`, [contractId, limit]);
    return r.rows;
  } catch (err) {
    console.warn("[active-contracts] activity read failed", { contractId, message: (err as Error)?.message });
    return [];
  }
}
