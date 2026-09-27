// BF_SERVER_BLOCK_v606_BI_APPLICANT_MESSAGES
// BI owns its applicant portal, so an Insurance-silo message must cross the
// service boundary instead of being left only in BF's communications table.

const DEFAULT_BI_SERVER_URL =
  "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

export type BiApplicantMessage = {
  contactId: string;
  body: string;
  messageId?: string | null;
  staffName?: string | null;
  ctaLabel?: string | null;
  ctaAction?: string | null;
};

export type BiApplicantMessageResult =
  | { ok: true }
  | { ok: false; error: string };

/** Notify BI-Server of a staff reply so it appears in the applicant's app. */
export async function notifyBiApplicant(message: BiApplicantMessage): Promise<BiApplicantMessageResult> {
  const base = (process.env.BI_SERVER_URL || DEFAULT_BI_SERVER_URL).replace(/\/+$/, "");
  const token = String(process.env.BACKEND_SERVICE_TOKEN ?? "").trim();
  if (!token) return { ok: false, error: "BACKEND_SERVICE_TOKEN is not configured" };
  // BF_SERVER_BLOCK_v610_BI_THREAD - BI-Server addresses the applicant by phone.
  let phone: string | null = null;
  try {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ phone: string | null }>(`SELECT phone FROM contacts WHERE id::text = $1 LIMIT 1`, [message.contactId]);
    phone = r.rows[0]?.phone ?? null;
  } catch (err) {
    console.warn("[bi-applicant-messages] phone lookup failed", { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const response = await fetch(`${base}/api/v1/bi/applicant-messages/from-bf`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-service-token": token,
        "x-silo": "BI",
      },
      body: JSON.stringify({
        contact_id: message.contactId,
        phone,
        body: message.body,
        message_id: message.messageId ?? null,
        staff_name: message.staffName ?? null,
        cta_label: message.ctaLabel ?? null,
        cta_action: message.ctaAction ?? null,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { ok: false, error: `BI-Server ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
