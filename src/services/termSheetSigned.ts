// BF_SERVER_BLOCK_v563 - PGI is offered only after the client signs a term sheet.
// "Signed" = the signed term sheet is on the file, or the SignNow webhook recorded
// the offer_term_sheet_signed stage change (covers a failed PDF attach).
export async function termSheetSigned(applicationId: string): Promise<boolean> {
  const { pool } = await import("../db.js");
  const r = await pool.query<{ signed: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM documents WHERE application_id::text = ($1)::text AND document_type = 'signed_term_sheet')
          OR EXISTS (SELECT 1 FROM application_stage_events WHERE application_id::text = ($1)::text AND trigger = 'offer_term_sheet_signed')) AS signed`,
    [applicationId],
  ).catch((err) => { console.warn("[term-sheet-signed] read_failed", { applicationId, message: err?.message }); return { rows: [] as { signed: boolean }[] }; });
  return Boolean(r.rows[0]?.signed);
}

export const PGI_PROMPT_LABEL = "Complete PGI Application";

/** Called when the term sheet is signed: send the PGI link that was held back. */
export async function sendPgiLinkAfterTermSheet(applicationId: string): Promise<"sent" | "none"> {
  const { pool } = await import("../db.js");
  const msg = await pool.query<{ url: string | null; phone: string | null }>(
    `SELECT m.cta_action AS url, c.phone
       FROM communications_messages m
       JOIN applications a ON a.id::text = m.application_id::text
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE m.application_id::text = ($1)::text AND m.cta_label = $2
      ORDER BY m.created_at DESC LIMIT 1`,
    [applicationId, PGI_PROMPT_LABEL],
  ).catch((err) => { console.warn("[term-sheet-signed] pgi_lookup_failed", { applicationId, message: err?.message }); return { rows: [] as { url: string | null; phone: string | null }[] }; });
  const row = msg.rows[0];
  if (!row?.url || !row.phone) return "none";
  const { notifyClient } = await import("./notifications/notifyClient.js");
  const r = await notifyClient({
    phone: row.phone, applicationId, kind: "pgi_ready", categoryId: "APPLICATION_UPDATE",
    sms: `Boreal Insurance: your term sheet is signed. Please complete your PGI application here: ${row.url}`,
    title: "Complete your PGI application", body: "Your term sheet is signed - one last step.",
  });
  return r.channel === "none" ? "none" : "sent";
}
