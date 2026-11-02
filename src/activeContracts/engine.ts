// BF_SERVER_v864_ACTIVE_CONTRACTS - the background renewal engine (one tick an hour, one instance at a time).
//   1. Every funded application without a contract gets one.
//   2. For each open contract, the rule in force decides Renewal Upcoming / Renewal Eligible.
//      Term contracts: 120 days before maturity flag upcoming; 90 days create the renewal opportunity, task and notify
//      the advisor (and the configured client message); 60 days follow up if the client has not responded; 30 days an
//      urgent task; at maturity an outcome is required. Percent-paid contracts: approaching the threshold -> upcoming,
//      reaching it -> eligible + opportunity + advisor notified (+ configured client message).
//   3. End-of-term prompts (90 / 30 days before the end-of-term date) and insurance certificate expiry tasks.
// Each milestone fires once (active_contract_milestones). Only the latest milestone that applies fires: a contract
// first seen 20 days before maturity gets the 30-day task, not four tasks. Client messages go only when an Admin has
// turned them on, only with consent, never in quiet hours (9pm-9am Alberta time: retried next tick), and every one is
// written on the CRM Timeline.
import { MATURITY_ORDER, type Evaluation } from "./model.js";
import { contractView, CONTRACT_COLUMNS, CONTRACT_FROM, sweepFundedApplications, type Q } from "./repo.js";
import { openOpportunity } from "./renewal.js";
import { writeContractEvent } from "./timeline.js";

export type EngineDeps = {
  now: () => Date;
  quietUntil: (now: Date) => Date | null;
  sendEmail: (to: string, subject: string, html: string, contactId: string) => Promise<boolean>;
  sendSms: (to: string, text: string) => Promise<boolean>;
};

export async function defaultEngineDeps(): Promise<EngineDeps> {
  const { nextAllowedSendTime } = await import("../modules/automation/conditions.js");
  return {
    now: () => new Date(),
    quietUntil: (now) => nextAllowedSendTime(now, process.env.AUTOMATION_QUIET_TZ || undefined),
    async sendEmail(to, subject, html, contactId) {
      const sg = await import("../services/sendgridService.js");
      if (!sg.sendgridConfigured()) return false;
      return (await sg.sendOne({ to, subject, html, contactId })).ok;
    },
    async sendSms(to, text) {
      const { sendSms } = await import("../modules/notifications/sms.service.js");
      await sendSms({ to, message: text, track: { kind: "active_contract_renewal" } });
      return true;
    },
  };
}

const FALLBACK_USER = `(SELECT id FROM users WHERE active = true ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1)`;

async function fire(db: Q, contractId: string, milestone: string, detail: string | null = null): Promise<boolean> {
  const r = await db.query(`INSERT INTO active_contract_milestones (contract_id, milestone, detail) VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING RETURNING milestone`, [contractId, milestone, detail]);
  return Boolean(r.rows[0]);
}

async function task(db: Q, c: any, title: string, body: string, priority: "MEDIUM" | "HIGH", dueDays: number, type = "CALL") {
  const silo = ["BF", "BI", "SLF", "KS"].includes(c.silo) ? c.silo : "BF";
  await db.query(
    `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, company_id, source)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval, COALESCE($7::uuid, ${FALLBACK_USER}), $8::uuid, $9::uuid, 'WORKFLOW')`,
    [silo, title.slice(0, 200), body, type, priority, String(dueDays), c.owner_user_id, c.contact_id, c.company_id]);
}

async function notifyAdvisor(db: Q, c: any, title: string, body: string) {
  if (!c.owner_user_id) return;
  await db.query(
    `INSERT INTO notifications (user_id, application_id, type, title, body, metadata, ref_table, ref_id, context_url)
     VALUES ($1::uuid, $2, 'active_contract', $3, $4, $5::jsonb, 'active_contracts', $6, $7)
     ON CONFLICT DO NOTHING`,
    [c.owner_user_id, c.application_id, title, body, JSON.stringify({ contract_id: c.id }), `${c.id}:${title}`, `/crm/active-contracts/${c.id}`]);
}

function label(c: any): string {
  return `${c.company_name ?? "Client"} - ${c.lender_name ?? "lender"} ${c.product_name ?? c.product_category ?? ""}`.trim();
}

function fill(t: string, c: any): string {
  return t.replace(/\{\{\s*company\s*\}\}/gi, c.company_name ?? "your business").replace(/\{\{\s*lender\s*\}\}/gi, c.lender_name ?? "your lender")
    .replace(/\{\{\s*first_name\s*\}\}/gi, String(c.contact_name ?? "").split(" ")[0] || "there");
}

/** The configured client message, with consent. Returns false to retry later (quiet hours), true when done. */
async function outreach(db: Q, deps: EngineDeps, c: any, settings: any, key: string): Promise<boolean> {
  if (!settings || (!settings.auto_email && !settings.auto_sms)) return true;
  const now = deps.now();
  if (deps.quietUntil(now)) return false;
  if (!(await fire(db, c.id, "outreach:" + key))) return true;
  const { SMS_ELIGIBLE_SQL, EMAIL_FALLBACK_ELIGIBLE_SQL, isCanadianMobile } = await import("../services/smsConsent.js");
  const p = (await db.query(
    `SELECT c.id::text AS id, c.email, c.phone, (${EMAIL_FALLBACK_ELIGIBLE_SQL}) AS email_ok, (${SMS_ELIGIBLE_SQL}) AS sms_ok
       FROM contacts c WHERE c.id::text = $1 LIMIT 1`, [c.contact_id ?? ""])).rows[0];
  if (!p) {
    await writeContractEvent(db, c.id, { title: "Automated renewal message not sent", detail: "No contact on the contract." });
    return true;
  }
  if (settings.auto_email && p.email_ok) {
    const subject = fill(settings.email_subject || "Reviewing your financing options", c);
    const body = fill(settings.email_body || "Hi {{first_name}},\n\nYour financing with {{lender}} may now be eligible for renewal or refinancing. Would you like Boreal to review your options? Just reply to this email.", c);
    const html = body.split(/\n\n+/).map((x) => `<p>${x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("")
      + `<p style="font-size:12px;color:#555">Boreal Financial, 450 Sparling Crt SW, Edmonton, AB T6X 1G9. You are receiving this because you have financing arranged by Boreal. Reply "unsubscribe" to stop these emails.</p>`;
    const ok = await deps.sendEmail(p.email, subject, html, p.id).catch((err) => { console.warn("[active-contracts] renewal email failed", { contractId: c.id, message: (err as Error)?.message }); return false; });
    await writeContractEvent(db, c.id, { title: ok ? "Automated renewal email sent" : "Automated renewal email failed", detail: subject, channel: "email" });
  } else if (settings.auto_email) {
    await writeContractEvent(db, c.id, { title: "Automated renewal email not sent", detail: "No email, or the client opted out.", channel: "email" });
  }
  if (settings.auto_sms && p.sms_ok && isCanadianMobile(p.phone)) {
    const text = fill(settings.sms_body || "Boreal Financial: your financing with {{lender}} may be eligible for renewal. Want us to review your options? Reply YES. Reply STOP to opt out.", c);
    const ok = await deps.sendSms(p.phone, text).catch((err) => { console.warn("[active-contracts] renewal sms failed", { contractId: c.id, message: (err as Error)?.message }); return false; });
    await writeContractEvent(db, c.id, { title: ok ? "Automated renewal SMS sent" : "Automated renewal SMS failed", detail: text, channel: "sms" });
  } else if (settings.auto_sms) {
    await writeContractEvent(db, c.id, { title: "Automated renewal SMS not sent", detail: "No text consent, opted out, or not a Canadian mobile.", channel: "sms" });
  }
  return true;
}

async function maturityStep(db: Q, deps: EngineDeps, c: any, ev: Evaluation, settings: any, renewable: boolean) {
  const ms = ev.maturity_milestone;
  if (!ms) return;
  const idx = MATURITY_ORDER.indexOf(ms);
  for (const earlier of MATURITY_ORDER.slice(0, idx)) await fire(db, c.id, earlier, "skipped (already past when first seen)");
  if (!(await fire(db, c.id, ms))) {
    if (ms === "d90" && renewable) await outreach(db, deps, c, settings, ms); // a quiet-hours retry
    return;
  }
  const days = ev.days_to_maturity ?? 0;
  if (ms === "d120") {
    if (renewable) await writeContractEvent(db, c.id, { title: "Renewal upcoming", detail: `Matures in ${days} days.` });
  } else if (ms === "d90" && renewable) {
    await openOpportunity(db, c.id, { auto: true, reason: `Matures in ${days} days` });
    await task(db, c, `Renewal outreach: ${label(c)}`, `Matures in ${days} days. Contact the client about renewal or refinancing.`, "MEDIUM", 2);
    await notifyAdvisor(db, c, "Renewal opportunity created", `${label(c)} matures in ${days} days.`);
    await outreach(db, deps, c, settings, "d90");
  } else if (ms === "d60" && renewable) {
    const opp = (await db.query(`SELECT status FROM active_contract_opportunities WHERE contract_id = $1::uuid AND status IN ('open','contacted','application_started') LIMIT 1`, [c.id])).rows[0];
    if (!opp || opp.status === "open") {
      await task(db, c, `Renewal follow-up: ${label(c)}`, `No response yet. Matures in ${days} days.`, "MEDIUM", 1);
      await outreach(db, deps, c, settings, "d60");
    }
  } else if (ms === "d30" && renewable) {
    await task(db, c, `URGENT renewal: ${label(c)}`, `Matures in ${days} days.`, "HIGH", 1);
    await notifyAdvisor(db, c, "Renewal urgent", `${label(c)} matures in ${days} days.`);
  } else if (ms === "matured") {
    await db.query(`UPDATE active_contracts SET outcome_required = true, updated_at = now() WHERE id = $1::uuid`, [c.id]);
    await task(db, c, `Record maturity outcome: ${label(c)}`, "The contract reached maturity. Record paid out, renewed/refinanced, closed or default.", "HIGH", 1, "TODO");
    await writeContractEvent(db, c.id, { title: "Contract reached maturity", detail: "An outcome is required." });
  }
}

export type TickResult = { created: number; checked: number; status_changes: number; failed: number };

export async function runEngineTick(db: Q, deps: EngineDeps): Promise<TickResult> {
  const created = await sweepFundedApplications(db);
  const now = deps.now();
  const settingsRows = (await db.query(`SELECT * FROM active_contract_settings`)).rows;
  const settingsBySilo = new Map(settingsRows.map((s: any) => [s.silo, s]));
  const rows = (await db.query(`SELECT ${CONTRACT_COLUMNS} FROM ${CONTRACT_FROM} WHERE c.status NOT IN ('refinanced','paid_out','matured','closed') ORDER BY c.created_at LIMIT 5000`)).rows;
  let changes = 0, failed = 0;
  for (const row of rows) {
    try {
      const v = contractView(row, now);
      const ev = v.renewal as Evaluation;
      const settings = settingsBySilo.get(row.silo) ?? null;
      const renewable = ev.eligibility !== "not_renewable" && row.status !== "default";
      if (ev.suggested_status && ev.suggested_status !== row.status && row.status !== "default") {
        await db.query(`UPDATE active_contracts SET status = $2, status_changed_at = now(), updated_at = now() WHERE id = $1::uuid AND status = $3`, [row.id, ev.suggested_status, row.status]);
        changes++;
        if (ev.suggested_status === "renewal_upcoming" && row.status === "active") await writeContractEvent(db, row.id, { title: "Renewal upcoming", detail: v.rule.description });
      }
      if (renewable && ev.eligibility === "eligible") {
        if (await fire(db, row.id, "eligible")) {
          await writeContractEvent(db, row.id, { title: "Renewal became eligible", detail: `${v.rule.description}${v.balance.percent_paid !== null ? ` - ${v.balance.percent_paid}% paid` : ""}` });
          await openOpportunity(db, row.id, { auto: true, reason: v.rule.description });
          await notifyAdvisor(db, row, "Renewal eligible", `${label(row)}: ${v.rule.description}.`);
          await task(db, row, `Renewal eligible: ${label(row)}`, v.rule.description, "MEDIUM", 2);
        }
        await outreach(db, deps, row, settings, "eligible");
      }
      if (row.status !== "default") await maturityStep(db, deps, row, ev, settings, renewable);
      if (ev.end_of_term_milestone && (await fire(db, row.id, ev.end_of_term_milestone + ":" + v.end_of_term_date))) {
        const d = ev.end_of_term_milestone === "eot30" ? 30 : 90;
        await task(db, row, `End of term in ${d} days: ${label(row)}`,
          `End of term ${v.end_of_term_date}. Options: ${row.buyout_option ? `buyout (${row.buyout_option}${row.buyout_price ? ` $${row.buyout_price}` : ""}), ` : ""}${row.residual_amount ? `residual $${row.residual_amount}, ` : ""}return, renew or upgrade the equipment.`,
          d === 30 ? "HIGH" : "MEDIUM", 2);
        await writeContractEvent(db, row.id, { title: "End-of-term options due", detail: `End of term ${v.end_of_term_date}` });
      }
      await insuranceStep(db, row, now);
    } catch (err) {
      failed++;
      console.error("[active-contracts] engine step failed", { contractId: row.id, message: (err as Error)?.message });
    }
  }
  return { created, checked: rows.length, status_changes: changes, failed };
}

async function insuranceStep(db: Q, c: any, now: Date) {
  const certs = (await db.query(
    `SELECT id::text AS id, insurer, policy_number, expires_on FROM active_contract_insurance
      WHERE contract_id = $1::uuid AND replaced_at IS NULL AND expires_on IS NOT NULL AND expires_on <= ($2::date + 30)`, [c.id, now.toISOString().slice(0, 10)])).rows;
  for (const cert of certs) {
    const exp = new Date(cert.expires_on);
    const expired = exp.getTime() < now.getTime();
    const key = (expired ? "insurance_expired:" : "insurance_30:") + cert.id;
    if (!(await fire(db, c.id, key))) continue;
    await task(db, c, `${expired ? "Insurance EXPIRED" : "Insurance expiring"}: ${label(c)}`,
      `${cert.insurer}${cert.policy_number ? ` policy ${cert.policy_number}` : ""} ${expired ? "expired" : "expires"} ${String(cert.expires_on).slice(0, 10)}. Get the renewed certificate.`, expired ? "HIGH" : "MEDIUM", 3, "TODO");
    await writeContractEvent(db, c.id, { title: expired ? "Insurance certificate expired" : "Insurance certificate expiring", detail: `${cert.insurer} - ${String(cert.expires_on).slice(0, 10)}` });
  }
}
