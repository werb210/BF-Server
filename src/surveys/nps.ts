// BF_SERVER_v869_SETTINGS_PACK_NPS - the post-funding survey and review request (Growth and Pro: plan feature nps_survey).
//
// When a deal funds, the client gets a short survey after the Admin's delay: "How likely are you to recommend us?"
// (0-10) and a comment, by email, and by text only when the contact has texting consent and has not said STOP. Clients
// who answer 9 or 10 are offered the brokerage's Google review link when one is set. Each answer goes on the contact's
// timeline and into the survey report (NPS = % promoters (9-10) - % detractors (0-6)).
//
// Only deals funded after the survey was switched on are surveyed, so switching it on never mails old clients.
import { createHash, randomBytes } from "node:crypto";
import { brandName } from "../settingsPack/boreal.js";
import { clientUrl } from "../settingsPack/boreal.js";
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export type NpsSettings = {
  enabled: boolean;
  enabled_since: string | null;
  delay_days: number;
  question: string;
  comment_prompt: string;
  email_subject: string;
  email_intro: string;
  sms_text: string;
  review_url: string;
};

export const defaultNps = (): NpsSettings => ({
  enabled: false,
  enabled_since: null,
  delay_days: 7,
  question: `How likely are you to recommend ${brandName()} to a friend or colleague?`,
  comment_prompt: "What is the main reason for your score?",
  email_subject: `Quick question from ${brandName()}`,
  email_intro: "Congratulations on your funding, and thank you for working with us. Would you answer one quick question?",
  sms_text: `${brandName()}: congratulations on your funding! One quick question about your experience:`,
  review_url: "",
});

const clip = (v: unknown, max: number, dflt: string) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : dflt;
};

export function normalizeNps(raw: unknown): NpsSettings {
  const d = defaultNps();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const delay = Math.round(Number(r.delay_days ?? d.delay_days));
  const review = String(r.review_url ?? "").trim();
  return {
    enabled: r.enabled === true,
    enabled_since: typeof r.enabled_since === "string" && !Number.isNaN(Date.parse(r.enabled_since)) ? r.enabled_since : null,
    delay_days: Number.isFinite(delay) ? Math.min(90, Math.max(0, delay)) : d.delay_days,
    question: clip(r.question, 200, d.question),
    comment_prompt: clip(r.comment_prompt, 200, d.comment_prompt),
    email_subject: clip(r.email_subject, 120, d.email_subject),
    email_intro: clip(r.email_intro, 600, d.email_intro),
    sms_text: clip(r.sms_text, 200, d.sms_text),
    review_url: /^https:\/\/\S+$/i.test(review) ? review.slice(0, 500) : "",
  };
}

export function validateNps(raw: unknown): { ok: true } | { ok: false; errors: Record<string, string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const errors: Record<string, string> = {};
  const delay = Number(r.delay_days);
  if (r.delay_days !== undefined && (!Number.isFinite(delay) || delay < 0 || delay > 90)) errors.delay_days = "Send it 0 to 90 days after funding.";
  if (r.review_url && !/^https:\/\/\S+$/i.test(String(r.review_url).trim())) errors.review_url = "Use the full https:// address of your Google review page.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true };
}

export async function npsSettings(db: Q): Promise<NpsSettings> {
  return readSetting(db, "nps", normalizeNps);
}

/** Saves the settings; switching on stamps enabled_since (only deals funded from then on are surveyed). */
export async function saveNps(db: Q, raw: unknown, actor: string | null): Promise<NpsSettings> {
  const before = await npsSettings(db);
  const next = normalizeNps({ ...(raw as object), enabled_since: before.enabled_since });
  if (next.enabled && (!before.enabled || !before.enabled_since)) next.enabled_since = new Date().toISOString();
  await writeSetting(db, "nps", next, actor);
  return next;
}

export const tokenHash = (t: string) => createHash("sha256").update(String(t)).digest("hex");
export const surveyUrl = (token: string) => `${clientUrl().replace(/\/+$/, "")}/survey/${encodeURIComponent(token)}`;

export type NpsCategory = "promoter" | "passive" | "detractor";
export const categoryOf = (score: number): NpsCategory => (score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor");

/** NPS from a list of scores: % promoters - % detractors, rounded; null with no answers. */
export function npsScore(scores: number[]): number | null {
  if (!scores.length) return null;
  const p = scores.filter((s) => s >= 9).length, d = scores.filter((s) => s <= 6).length;
  return Math.round(((p - d) / scores.length) * 100);
}

// ------------------------------------------------------------------ the worker's two jobs
/** Queues a survey for each deal funded since the survey was switched on (once per application). */
export async function queueFundedDeals(db: Q, s: NpsSettings): Promise<number> {
  if (!s.enabled || !s.enabled_since) return 0;
  const r = await db.query(
    `INSERT INTO nps_surveys (application_id, contact_id, due_at)
     SELECT a.id::text, a.contact_id, a.funded_at + make_interval(days => $2::int)
       FROM applications a
      WHERE a.funded_at IS NOT NULL AND a.funded_at >= $1::timestamptz AND a.contact_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM nps_surveys n WHERE n.application_id = a.id::text)
      LIMIT 500
     ON CONFLICT (application_id) DO NOTHING
     RETURNING id`, [s.enabled_since, s.delay_days]);
  return r.rows.length;
}

export type SendDeps = {
  email: (to: string, subject: string, html: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sms: (to: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => Date;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export function surveyEmail(s: NpsSettings, name: string | null, token: string): { subject: string; html: string; text: string } {
  const url = surveyUrl(token);
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = [hi, "", s.email_intro, "", s.question, `Answer here (it takes 10 seconds): ${url}`, "", brandName()].join("\n");
  const links = Array.from({ length: 11 }, (_, n) =>
    `<a href="${esc(`${url}?score=${n}`)}" style="display:inline-block;width:30px;padding:8px 0;margin:2px;text-align:center;border:1px solid #1d4ed8;border-radius:6px;color:#1d4ed8;text-decoration:none;font-weight:bold">${n}</a>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827;line-height:1.5">
<p>${esc(hi)}</p><p>${esc(s.email_intro)}</p><p style="font-weight:bold">${esc(s.question)}</p>
<div>${links}</div><p style="color:#374151;font-size:13px">0 = not at all likely, 10 = extremely likely</p><p>${esc(brandName())}</p></div>`;
  return { subject: s.email_subject, html, text };
}

/** Sends the surveys now due. Each is claimed (status sending) before anything is sent. */
export async function sendDueSurveys(db: Q, s: NpsSettings, deps: SendDeps): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!s.enabled) return out;
  const now = deps.now?.() ?? new Date();
  const claimed = await db.query(
    `UPDATE nps_surveys SET status = 'sending' WHERE id IN (
       SELECT id FROM nps_surveys WHERE status = 'pending' AND due_at <= $1 ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING id::text AS id, contact_id::text AS contact_id, application_id`, [now.toISOString()]);
  for (const row of claimed.rows as Array<{ id: string; contact_id: string | null; application_id: string }>) {
    const c = row.contact_id ? await db.query(
      `SELECT COALESCE(NULLIF(first_name, ''), NULLIF(split_part(name, ' ', 1), '')) AS first_name, email, phone,
              COALESCE(marketing_opt_out, false) AS email_out, COALESCE(sms_opt_out, false) AS sms_out, sms_consent
         FROM contacts WHERE id::text = $1`, [row.contact_id]) : { rows: [] };
    const contact = c.rows[0] as { first_name: string | null; email: string | null; phone: string | null; email_out: boolean; sms_out: boolean; sms_consent: boolean | null } | undefined;
    const token = randomBytes(24).toString("base64url");
    const channels: string[] = [];
    let error = "";
    if (contact?.email && !contact.email_out) {
      const m = surveyEmail(s, contact.first_name, token);
      const r = await deps.email(contact.email, m.subject, m.html, m.text);
      if (r.ok) channels.push("email"); else error = r.error ?? "email_failed";
    }
    if (contact?.phone && contact.sms_consent === true && !contact.sms_out) {
      const r = await deps.sms(contact.phone, `${s.sms_text} ${surveyUrl(token)} Reply STOP to opt out.`);
      if (r.ok) channels.push("sms"); else error = error || (r.error ?? "sms_failed");
    }
    if (channels.length) {
      await db.query(`UPDATE nps_surveys SET status = 'sent', sent_at = now(), token_hash = $2, channels = $3::text[] WHERE id::text = $1`, [row.id, tokenHash(token), channels]);
      await db.query(`INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload) VALUES ($1::uuid, $2, 'nps_survey_sent', $3::jsonb)`,
        [row.contact_id, row.application_id, JSON.stringify({ channels })]);
      out.sent += 1;
    } else {
      const reason = error || (!contact ? "no_contact" : "no_consented_channel");
      await db.query(`UPDATE nps_surveys SET status = $2, skip_reason = $3 WHERE id::text = $1`, [row.id, error ? "failed" : "skipped", reason]);
      if (error) { out.failed += 1; console.warn("[nps] survey not sent", { surveyId: row.id, reason }); } else out.skipped += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------ answers and the report
export async function surveyByToken(db: Q, token: string): Promise<{ id: string; contact_id: string | null; application_id: string; status: string; score: number | null } | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const r = await db.query(`SELECT id::text AS id, contact_id::text AS contact_id, application_id, status, score FROM nps_surveys WHERE token_hash = $1`, [tokenHash(token)]);
  return (r.rows[0] as any) ?? null;
}

export async function recordAnswer(db: Q, s: NpsSettings, token: string, score: number, comment: string | null): Promise<{ ok: true; review_url: string | null } | { ok: false; status: number; error: string }> {
  if (!Number.isInteger(score) || score < 0 || score > 10) return { ok: false, status: 400, error: "score_out_of_range" };
  const survey = await surveyByToken(db, token);
  if (!survey) return { ok: false, status: 404, error: "not_found" };
  const review = score >= 9 && s.review_url ? s.review_url : null;
  // A second answer (a change of mind) replaces the first; the timeline keeps both.
  await db.query(
    `UPDATE nps_surveys SET status = 'responded', score = $2, comment = $3, responded_at = now(), review_link_shown = review_link_shown OR $4 WHERE id::text = $1`,
    [survey.id, score, comment, Boolean(review)]);
  if (survey.contact_id) {
    await db.query(`INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload) VALUES ($1::uuid, $2, 'nps_response', $3::jsonb)`,
      [survey.contact_id, survey.application_id, JSON.stringify({ score, comment, category: categoryOf(score) })]);
  }
  return { ok: true, review_url: review };
}

export async function npsReport(db: Q, days = 365): Promise<{
  nps: number | null; responses: number; sent: number; promoters: number; passives: number; detractors: number; response_rate: number | null;
  by_month: Array<{ month: string; nps: number | null; responses: number }>;
  recent: Array<{ contact_id: string | null; contact_name: string | null; score: number; comment: string | null; responded_at: string }>;
}> {
  const r = await db.query(
    `SELECT n.score, n.comment, n.responded_at, n.status, n.sent_at, n.contact_id::text AS contact_id, c.name AS contact_name
       FROM nps_surveys n LEFT JOIN contacts c ON c.id = n.contact_id
      WHERE COALESCE(n.responded_at, n.sent_at, n.created_at) >= now() - make_interval(days => $1::int)
      ORDER BY n.responded_at DESC NULLS LAST LIMIT 5000`, [days]);
  const rows = r.rows as Array<{ score: number | null; comment: string | null; responded_at: string | null; status: string; sent_at: string | null; contact_id: string | null; contact_name: string | null }>;
  const answered = rows.filter((x) => x.score !== null && x.responded_at);
  const scores = answered.map((x) => Number(x.score));
  const sent = rows.filter((x) => x.sent_at).length;
  const months = new Map<string, number[]>();
  for (const a of answered) {
    const m = new Date(a.responded_at!).toISOString().slice(0, 7);
    months.set(m, [...(months.get(m) ?? []), Number(a.score)]);
  }
  return {
    nps: npsScore(scores),
    responses: scores.length,
    sent,
    promoters: scores.filter((x) => x >= 9).length,
    passives: scores.filter((x) => x >= 7 && x <= 8).length,
    detractors: scores.filter((x) => x <= 6).length,
    response_rate: sent ? Math.round((scores.length / sent) * 100) : null,
    by_month: [...months.entries()].sort().map(([month, list]) => ({ month, nps: npsScore(list), responses: list.length })),
    recent: answered.slice(0, 50).map((x) => ({ contact_id: x.contact_id, contact_name: x.contact_name, score: Number(x.score), comment: x.comment, responded_at: new Date(x.responded_at!).toISOString() })),
  };
}
