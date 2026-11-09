// BF_SERVER_v874_MARKETING_TOOLS - the two send options for an email campaign (ported from KS-server #48 without the
// Marketing add-on, the campaign email allowance or the meter), run by the send-queue worker in phases (each phase
// ends with the job queued again for later, or done):
//
//   Subject-line A/B test   phase "test": a sample of the audience (testPercent, 10-50%, default 20) gets subject A or
//                           B, half each. The job waits waitHours (1-24, default 4). Phase "winner": the subject with the
//                           higher open rate (then click rate; a tie keeps A) goes to everyone else.
//   Each person's best time phase "schedule": each person gets the email at the hour of day they most often opened
//                           earlier emails (Alberta time, UTC-6 all year; within the next 24 hours); people with no
//                           history get it now. Best hours are kept inside 09:00-20:00 (the automation quiet hours), so
//                           this option never sends earlier or later than Boreal already does. Phase "deliver" sends
//                           the ones that are due, until none are left.
//
// Everything else is the ordinary blast (src/services/marketingSendRunner.ts): the silo, CASL consent, opt-outs (checked
// again at delivery), the 24-hour duplicate guard and the campaign ledger (campaign_sends).
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { brokerageTimeZone, zonedParts } from "../settingsPack/boreal.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  EMAIL_BLAST_ELIGIBLE_SQL, emailAudienceGiven, emailRecipients, sendCampaignEmailTo,
  type EmailJob, type EmailRecipient, type SendProgress, type ShouldAbort,
} from "../services/marketingSendRunner.js";

export const AB_DEFAULTS = { testPercent: 20, waitHours: 4 } as const;
export const AB_LIMITS = { minPercent: 10, maxPercent: 50, minHours: 1, maxHours: 24 } as const;

export type AbPlan = {
  subjectB: string;
  testPercent: number;
  waitHours: number;
  phase?: "test" | "winner";
  testEndsAt?: string;
  winner?: "A" | "B";
  results?: Record<"A" | "B", { sent: number; opened: number; clicked: number }>;
};

export type CampaignOptions = { ab?: AbPlan; sendTime?: "best" };

export type CampaignOptionsResult = { ok: true; value: CampaignOptions } | { ok: false; error: string; message: string };

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Reads the send options of POST /api/marketing/email/send(-template): abTest { subjectB, testPercent?, waitHours? }
 *  and sendTime "best" (anything else is "send at the chosen time", as before). */
export function parseCampaignOptions(body: Record<string, any>, subjectA: string): CampaignOptionsResult {
  const out: CampaignOptions = {};
  const raw = body?.abTest;
  if (raw && typeof raw === "object" && raw.enabled !== false) {
    const subjectB = String(raw.subjectB ?? "").trim();
    if (!subjectB) return { ok: false, error: "ab_subject_required", message: "Write the second subject line for the A/B test." };
    if (subjectB === subjectA.trim()) return { ok: false, error: "ab_subjects_same", message: "The two subject lines are the same. Change one of them." };
    if (subjectB.length > 300) return { ok: false, error: "ab_subject_too_long", message: "The second subject line is too long." };
    out.ab = {
      subjectB,
      testPercent: clampInt(raw.testPercent, AB_LIMITS.minPercent, AB_LIMITS.maxPercent, AB_DEFAULTS.testPercent),
      waitHours: clampInt(raw.waitHours, AB_LIMITS.minHours, AB_LIMITS.maxHours, AB_DEFAULTS.waitHours),
      phase: "test",
    };
  }
  if (body?.sendTime === "best") out.sendTime = "best";
  if (out.ab && out.sendTime) {
    return { ok: false, error: "ab_and_best_time", message: "Choose either the subject-line test or each person's best time, not both." };
  }
  return { ok: true, value: out };
}

// ------------------------------------------------------------------------------------------------------ helpers

/** A stable shuffle: the same job always splits the same people the same way (so a resumed job does not re-split). */
export function stableOrder<T extends { id: string }>(jobId: string, rows: T[]): T[] {
  const key = (id: string) => createHash("sha1").update(`${jobId}:${id}`).digest("hex");
  return [...rows].map((r) => ({ r, k: key(r.id) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((x) => x.r);
}

/** How many people the test goes to: testPercent of the audience, at least 2, at most everyone. */
export function abSampleSize(total: number, testPercent: number): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(2, Math.round((total * testPercent) / 100)));
}

export type VariantStats = Record<"A" | "B", { sent: number; opened: number; clicked: number }>;

/** The winner: the higher open rate, then the higher click rate; a tie keeps A. */
export function pickWinner(stats: VariantStats): "A" | "B" {
  const rate = (v: "A" | "B", k: "opened" | "clicked") => (stats[v].sent > 0 ? stats[v][k] / stats[v].sent : 0);
  if (rate("B", "opened") > rate("A", "opened")) return "B";
  if (rate("B", "opened") < rate("A", "opened")) return "A";
  return rate("B", "clicked") > rate("A", "clicked") ? "B" : "A";
}

/** Best-time sends stay inside the automation sending window: 09:00 to 20:00 local (the last start is 19:00). */
export const SEND_WINDOW = { firstHour: 9, lastHour: 19 } as const;

/** The hour (9-19) a person most often opened emails, from open times; null with no history. Ties: the earlier hour.
 *  An hour outside the sending window moves to its nearest edge (a 6 a.m. reader gets it at 9, a 23:00 reader at 19). */
export function bestHour(openTimes: Date[], tz: string): number | null {
  if (!openTimes.length) return null;
  const counts = new Array<number>(24).fill(0);
  for (const t of openTimes) counts[zonedParts(t, tz).hour] += 1;
  let best = 0;
  for (let h = 1; h < 24; h++) if (counts[h] > counts[best]) best = h;
  if (counts[best] <= 0) return null;
  return Math.min(SEND_WINDOW.lastHour, Math.max(SEND_WINDOW.firstHour, best));
}

/** The next moment (on the hour) within 24 hours when the local hour is `hour`. */
export function nextHourAt(now: Date, hour: number, tz: string): Date {
  const top = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  for (let k = 0; k <= 24; k++) {
    const t = new Date(top.getTime() + k * 3_600_000);
    if (t.getTime() >= now.getTime() && zonedParts(t, tz).hour === hour) return t;
  }
  return now;
}

/** Sends within this many minutes of now go now. */
const DUE_WINDOW_MS = 10 * 60_000;

async function alreadyInCampaign(pool: Pool, jobId: string): Promise<Set<string>> {
  const r = await pool.query<{ contact_id: string }>(`SELECT contact_id::text AS contact_id FROM campaign_sends WHERE job_id = $1`, [jobId]);
  return new Set(r.rows.map((x) => String(x.contact_id)));
}

export async function variantStats(pool: Pool, jobId: string): Promise<VariantStats> {
  const r = await pool.query<{ variant: "A" | "B"; sent: number; opened: number; clicked: number }>(
    `SELECT variant, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
            COUNT(opened_at)::int AS opened, COUNT(clicked_at)::int AS clicked
       FROM campaign_sends WHERE job_id = $1 GROUP BY variant`,
    [jobId],
  );
  const out: VariantStats = { A: { sent: 0, opened: 0, clicked: 0 }, B: { sent: 0, opened: 0, clicked: 0 } };
  for (const row of r.rows) if (row.variant === "A" || row.variant === "B") out[row.variant] = { sent: Number(row.sent) || 0, opened: Number(row.opened) || 0, clicked: Number(row.clicked) || 0 };
  return out;
}

async function ledgerTotals(pool: Pool, jobId: string): Promise<{ sent: number; failed: number; scheduled: number }> {
  const r = await pool.query<{ sent: number; failed: number; scheduled: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled
       FROM campaign_sends WHERE job_id = $1`,
    [jobId],
  );
  const row = r.rows[0];
  return { sent: Number(row?.sent ?? 0) || 0, failed: Number(row?.failed ?? 0) || 0, scheduled: Number(row?.scheduled ?? 0) || 0 };
}

type Batch = Array<{ c: EmailRecipient; subject: string; variant: "A" | "B"; claimedSendId?: string }>;

/** Sends a batch; stops when the job is cancelled. */
async function sendBatch(pool: Pool, job: EmailJob, batch: Batch, onProgress?: SendProgress, shouldAbort?: ShouldAbort) {
  let sent = 0, failed = 0, aborted = false, i = 0;
  let firstError: string | undefined;
  for (const b of batch) {
    const r = await sendCampaignEmailTo(pool, job, b.c, { subject: b.subject, variant: b.variant, claimedSendId: b.claimedSendId ?? null });
    if (r.outcome === "sent") sent++;
    else if (r.outcome === "failed") { failed++; firstError ??= r.error; }
    i++;
    if (i % 50 === 0) {
      if (onProgress) { try { await onProgress(sent, failed); } catch (err) { logWarnSwallowed(err, "marketing/campaignRunner.ts:progress"); } }
      if (shouldAbort) { try { if (await shouldAbort()) { aborted = true; break; } } catch (err) { logWarnSwallowed(err, "marketing/campaignRunner.ts:abort"); } }
    }
  }
  return { sent, failed, aborted, firstError };
}

// --------------------------------------------------------------------------------------------------------- runner

export type CampaignJobRow = {
  id: string;
  silo: string;
  tag: string | null;
  payload: Record<string, any>;
};

export type CampaignStep = {
  status: "done" | "canceled" | "waiting";
  /** When waiting: when the job runs again. */
  notBefore?: Date;
  /** Merged into the job's payload. */
  payloadPatch?: Record<string, unknown>;
  total: number;
  sent: number;
  failed: number;
  error?: string | null;
};

export function jobOf(row: CampaignJobRow): EmailJob {
  const p = row.payload ?? {};
  return {
    silo: row.silo, tag: row.tag, subject: String(p.subject || ""), html: String(p.html || ""),
    tags: (p.tags as string[] | undefined) ?? null, excludeTags: (p.excludeTags as string[] | undefined) ?? null,
    templateId: (p.templateId as string | undefined) ?? null, resend: p.resend === true, jobId: row.id,
    skipTextedDays: Number.isInteger(p.skipTextedDays) ? Number(p.skipTextedDays) : null, // BF_SERVER_v923_SKIP_TEXTED
  };
}

export async function runCampaignEmailJob(
  pool: Pool, row: CampaignJobRow, onProgress?: SendProgress, shouldAbort?: ShouldAbort, now: Date = new Date(),
): Promise<CampaignStep> {
  const job = jobOf(row);
  if (!emailAudienceGiven(job)) return { status: "done", total: 0, sent: 0, failed: 0, error: "audience_required" };
  const p = row.payload ?? {};
  const ab = p.ab as AbPlan | undefined;
  const best = p.sendTime === "best";
  const finish = async (extra: Partial<CampaignStep> & Pick<CampaignStep, "status">): Promise<CampaignStep> => {
    const t = await ledgerTotals(pool, row.id);
    return { total: t.sent + t.failed + t.scheduled, sent: t.sent, failed: t.failed, ...extra };
  };

  // ---- each person's best time
  if (best) {
    const tz = brokerageTimeZone();
    if (p.phase !== "deliver") {
      const done = await alreadyInCampaign(pool, row.id);
      const people = (await emailRecipients(pool, job)).filter((c) => !done.has(String(c.id)));
      const opens = people.length
        ? await pool.query<{ contact_id: string; created_at: Date }>(
            `SELECT contact_id::text AS contact_id, created_at FROM crm_timeline_events
              WHERE contact_id::text = ANY($1::text[]) AND event_type = 'email_open' AND created_at > now() - interval '180 days'
              ORDER BY created_at DESC LIMIT 50000`,
            [people.map((c) => String(c.id))],
          )
        : { rows: [] as Array<{ contact_id: string; created_at: Date }> };
      const byPerson = new Map<string, Date[]>();
      for (const o of opens.rows) {
        const list = byPerson.get(String(o.contact_id)) ?? [];
        list.push(new Date(o.created_at));
        byPerson.set(String(o.contact_id), list);
      }
      const nowBatch: Batch = [];
      for (const c of people) {
        const h = bestHour(byPerson.get(String(c.id)) ?? [], tz);
        const at = h === null ? now : nextHourAt(now, h, tz);
        if (at.getTime() - now.getTime() <= DUE_WINDOW_MS) { nowBatch.push({ c, subject: job.subject, variant: "A" }); continue; }
        await pool.query(
          `INSERT INTO campaign_sends (job_id, contact_id, silo, variant, subject, status, scheduled_for)
           VALUES ($1, $2, $3, 'A', $4, 'scheduled', $5) ON CONFLICT (job_id, contact_id) DO NOTHING`,
          [row.id, c.id, row.silo, job.subject, at.toISOString()],
        );
      }
      const r = await sendBatch(pool, job, nowBatch, onProgress, shouldAbort);
      if (r.aborted) return finish({ status: "canceled" });
    } else {
      // Deliver the ones that are due (claimed first, so two workers never send the same one).
      const due = await pool.query<{ id: string; contact_id: string }>(
        `UPDATE campaign_sends SET status = 'sent', sent_at = now()
          WHERE job_id = $1 AND status = 'scheduled' AND scheduled_for <= $2::timestamptz
          RETURNING id, contact_id::text AS contact_id`,
        [row.id, new Date(now.getTime() + 60_000).toISOString()],
      );
      if (due.rows.length) {
        const people = await pool.query<EmailRecipient>(
          `SELECT c.id::text AS id, c.email, c.name, co.name AS company
             FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
            WHERE c.id::text = ANY($1::text[]) AND c.silo = $2 AND ${EMAIL_BLAST_ELIGIBLE_SQL}`,
          [due.rows.map((d) => String(d.contact_id)), row.silo],
        );
        const byId = new Map(people.rows.map((c) => [String(c.id), c]));
        const batch: Batch = [];
        for (const d of due.rows) {
          const c = byId.get(String(d.contact_id));
          // Opted out or no longer reachable since it was scheduled: not sent.
          if (!c) { await pool.query(`UPDATE campaign_sends SET status = 'skipped' WHERE id = $1`, [d.id]); continue; }
          batch.push({ c, subject: job.subject, variant: "A", claimedSendId: d.id });
        }
        const r = await sendBatch(pool, job, batch, onProgress, shouldAbort);
        if (r.aborted) return finish({ status: "canceled" });
      }
    }
    const next = await pool.query<{ at: Date | null }>(
      `SELECT MIN(scheduled_for) AS at FROM campaign_sends WHERE job_id = $1 AND status = 'scheduled'`, [row.id],
    );
    const at = next.rows[0]?.at ? new Date(next.rows[0].at) : null;
    if (at) return finish({ status: "waiting", notBefore: at, payloadPatch: { phase: "deliver" } });
    return finish({ status: "done", payloadPatch: { phase: "done" } });
  }

  // ---- subject-line A/B test
  if (ab && ab.subjectB) {
    const done = await alreadyInCampaign(pool, row.id);
    const people = stableOrder(row.id, (await emailRecipients(pool, job)).filter((c) => !done.has(String(c.id))));
    if (ab.phase !== "winner") {
      const size = abSampleSize(people.length + done.size, ab.testPercent) - done.size;
      const sample = people.slice(0, Math.max(0, size));
      const batch: Batch = sample.map((c, i) => (i % 2 === 0
        ? { c, subject: job.subject, variant: "A" as const }
        : { c, subject: ab.subjectB, variant: "B" as const }));
      const r = await sendBatch(pool, job, batch, onProgress, shouldAbort);
      if (r.aborted) return finish({ status: "canceled" });
      if (sample.length >= people.length) {
        // Everyone was in the test (a small audience): nothing left to send.
        const stats = await variantStats(pool, row.id);
        return finish({ status: "done", payloadPatch: { ab: { ...ab, phase: "winner", winner: pickWinner(stats), results: stats } } });
      }
      const ends = new Date(now.getTime() + ab.waitHours * 3_600_000);
      return finish({ status: "waiting", notBefore: ends, payloadPatch: { ab: { ...ab, phase: "winner", testEndsAt: ends.toISOString() } } });
    }
    const stats = await variantStats(pool, row.id);
    const winner = pickWinner(stats);
    const subject = winner === "B" ? ab.subjectB : job.subject;
    const r = await sendBatch(pool, job, people.map((c) => ({ c, subject, variant: winner })), onProgress, shouldAbort);
    const patch = { ab: { ...ab, phase: "winner" as const, winner, results: stats } };
    if (r.aborted) return finish({ status: "canceled", payloadPatch: patch });
    return finish({ status: "done", payloadPatch: patch });
  }

  // ---- a plain blast through this runner (not normally used: the worker sends those with runEmailSend)
  const done = await alreadyInCampaign(pool, row.id);
  const people = (await emailRecipients(pool, job)).filter((c) => !done.has(String(c.id)));
  const r = await sendBatch(pool, job, people.map((c) => ({ c, subject: job.subject, variant: "A" as const })), onProgress, shouldAbort);
  if (r.aborted) return finish({ status: "canceled" });
  return finish({ status: "done" });
}

/** True when the job needs this runner (an A/B test or best-time sending); else the worker sends it as a plain blast. */
export function needsCampaignRunner(payload: Record<string, any> | null | undefined): boolean {
  return Boolean(payload && ((payload.ab && typeof payload.ab === "object" && payload.ab.subjectB) || payload.sendTime === "best"));
}
