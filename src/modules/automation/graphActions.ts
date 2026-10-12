// BF_SERVER_v786_WORKFLOW_GRAPH - v2 workflow actions. Each returns a short description of what
// happened, or throws (the engine retries, then fails the enrollment). A "skip:" prefix means the
// action did not apply - not an error.
import { renderTokens, CONTACT_FIELDS_SETTABLE, type ActionNode } from "./graph.js";
import { FALLBACK_USER_SQL, SYSTEM_USER, type EngineDeps } from "./automationContext.js";
import { runAction as runV1Action } from "./automationSteps.js";
import { ssrfSafeFetch, SsrfBlockedError } from "../../security/ssrfGuard.js"; // BF_SERVER_v789_SSRF_GUARD
import { recordAuditEvent, type AuditParams } from "../audit/audit.service.js"; // BF_SERVER_v789_SSRF_GUARD
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";

const TASK_TYPES = ["CALL", "EMAIL", "SMS", "TODO"];
const TASK_PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH"];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** A saved template by id: marketing_template (channel email/sms) or message_templates (channel email/sms). */
export async function loadTemplate(deps: EngineDeps, channel: "email" | "sms", id: string): Promise<{ subject: string; html: string; text: string } | null> {
  const q = deps.query;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const m = await q(`SELECT name, subject, html, body FROM marketing_template WHERE id::text = $1 AND channel = $2 LIMIT 1`, [id, channel]);
  if (m.rows[0]) {
    const r = m.rows[0];
    return { subject: String(r.subject ?? r.name ?? ""), html: String(r.html ?? r.body ?? ""), text: String(r.body ?? "") };
  }
  const t = await q(`SELECT name, subject, body_html, body_text FROM message_templates WHERE id::text = $1 AND channel = $2 LIMIT 1`, [id, channel]);
  if (t.rows[0]) {
    const r = t.rows[0];
    return { subject: String(r.subject ?? r.name ?? ""), html: String(r.body_html ?? (r.body_text ? esc(String(r.body_text)).replace(/\n/g, "<br>") : "")), text: String(r.body_text ?? "") };
  }
  return null;
}

// BF_SERVER_v789_SSRF_GUARD - one audit_events row per webhook send: workflow id,
// host, and the NAMES of the fields sent (never their values). Written through the
// engine's own query so it lands in the same database the engine uses. An audit
// failure is logged and never fails the step.
async function auditWebhookSend(
  deps: EngineDeps,
  e: any,
  info: { host: string; finalHost: string; fields: string[]; status: number | null; outcome: string },
): Promise<void> {
  try {
    await recordAuditEvent({
      actorUserId: null,
      targetUserId: null,
      targetType: "automation_rule",
      targetId: e?.rule_id != null ? String(e.rule_id) : null,
      action: "automation_webhook_send",
      success: info.outcome === "sent",
      metadata: {
        workflowId: e?.rule_id ?? null,
        enrollmentId: e?.id ?? null,
        host: info.host,
        finalHost: info.finalHost,
        fields: ["workflowId", "enrollmentId", "contactId", "applicationId", ...info.fields],
        status: info.status,
        outcome: info.outcome,
      },
      client: { query: deps.query } as unknown as AuditParams["client"],
    });
  } catch (err) {
    logWarnSwallowed(err, "automation.webhook.audit");
  }
}

async function ownerOf(deps: EngineDeps, e: any, to: unknown): Promise<string | null> {
  if (typeof to === "string" && /^[0-9a-f-]{36}$/i.test(to)) return to;
  const r = await deps.query(
    `SELECT COALESCE((SELECT owner_user_id FROM applications WHERE id::text = $1), (SELECT owner_id FROM contacts WHERE id::text = $2), ${FALLBACK_USER_SQL})::text AS id`,
    [e.application_id, e.contact_id]);
  return r.rows[0]?.id ?? null;
}

async function setOwner(deps: EngineDeps, e: any, userId: string): Promise<string> {
  const q = deps.query;
  if (e.contact_id) await q(`UPDATE contacts SET owner_id = $2::uuid, updated_at = now() WHERE id::text = $1`, [e.contact_id, userId]);
  if (e.application_id) await q(`UPDATE applications SET owner_user_id = $2::uuid WHERE id::text = $1`, [e.application_id, userId]);
  const u = await q(`SELECT first_name, last_name FROM users WHERE id = $1::uuid`, [userId]);
  const name = [u.rows[0]?.first_name, u.rows[0]?.last_name].filter(Boolean).join(" ");
  e.context = { ...(e.context ?? {}), owner_name: name || e.context?.owner_name, contact_owner_id: userId, owner_id: userId };
  return `owner ${userId}`;
}

export async function runGraphAction(deps: EngineDeps, e: any, node: ActionNode): Promise<string> {
  const q = deps.query;
  const p = (node.params ?? {}) as Record<string, any>;
  const ctx = e.context ?? {};
  const t = (s: unknown) => renderTokens(s, ctx);
  switch (node.action) {
    case "send_email": {
      if (!e.contact_id) return "skip: no contact";
      const tpl = await loadTemplate(deps, "email", String(p.templateId ?? ""));
      if (!tpl) throw new Error("email template not found");
      // Marketing send path: unsubscribed / bounced / spam-reported contacts (marketing_opt_out) are suppressed.
      const c = await q(`SELECT c.email FROM contacts c WHERE c.id::text = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out, false) = false LIMIT 1`, [e.contact_id]);
      const to = c.rows[0]?.email;
      if (!to) return "skip: no email or unsubscribed";
      if (!deps.sendEmail) throw new Error("email sending is not configured");
      const subject = t(tpl.subject).slice(0, 300);
      const r = await deps.sendEmail({ to, subject, html: t(tpl.html), contactId: e.contact_id, from: typeof p.fromMailbox === "string" && p.fromMailbox ? p.fromMailbox : null });
      if (!r.ok) throw new Error(`email failed: ${String(r.error ?? "").slice(0, 200)}`);
      await q(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1::uuid, 'email_marketing_sent', $2::jsonb)`, [e.contact_id, JSON.stringify({ subject, source: "automation", rule_id: e.rule_id })]);
      return `email sent: ${subject}`;
    }
    case "send_sms": {
      if (!e.contact_id) return "skip: no contact";
      let body = String(p.body ?? "");
      if (p.templateId) {
        const tpl = await loadTemplate(deps, "sms", String(p.templateId));
        if (!tpl) throw new Error("text template not found");
        body = tpl.text || tpl.html;
      }
      // The existing consent-checked SMS path (v1 send_sms): marketing needs CASL consent, transactional needs no opt-out.
      return runV1Action(deps, e, { type: "send_sms", purpose: p.kind === "transactional" ? "transactional" : "marketing", body });
    }
    case "notify_client":
      return runV1Action(deps, e, { type: "notify_client", title: p.title, body: p.body });
    case "team_post":
      return runV1Action(deps, e, { type: "team_post", channel: p.channel, body: p.body ?? p.message });
    case "add_note":
      return runV1Action(deps, e, { type: "add_note", body: p.body });
    case "notify_staff": {
      const channel = String(p.channel ?? "in_app");
      const message = t(p.message ?? "Automation update").slice(0, 1000);
      const link = e.application_id ? `/applications/${e.application_id}` : e.contact_id ? `/crm/contacts/${e.contact_id}` : "/automations";
      if (channel === "team") {
        const { postTeamAlert } = await import("../../services/team/teamPhaseC.js");
        const room = String(p.teamChannel ?? "automations").replace(/^#/, "");
        return (await postTeamAlert(room, message)) ? `posted in #${room}` : "skip: could not post";
      }
      const userId = await ownerOf(deps, e, p.to);
      if (!userId) return "skip: nobody to notify";
      if (channel === "in_app") {
        await q(`INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url) VALUES ($1::uuid, 'automation', 'automation_enrollments', $2, $3, $4)`,
          [userId, e.id, message.slice(0, 500), link]);
        return `staff ${userId} notified in the portal`;
      }
      const u = await q(`SELECT email, COALESCE(NULLIF(phone_number,''), phone) AS phone FROM users WHERE id = $1::uuid`, [userId]);
      if (channel === "sms") {
        const phone = u.rows[0]?.phone;
        if (!phone) return "skip: staff member has no phone";
        await deps.sendSms(phone, message);
        return `staff ${userId} texted`;
      }
      const email = u.rows[0]?.email;
      if (!email) return "skip: staff member has no email";
      if (!deps.sendStaffEmail) throw new Error("email sending is not configured");
      const base = String(process.env.PORTAL_URL ?? "https://staff.boreal.financial").replace(/\/$/, "");
      const r = await deps.sendStaffEmail({ to: email, subject: "Boreal automation: " + message.slice(0, 80), html: `<p>${esc(message)}</p><p><a href="${base}${link}">Open in the portal</a></p>` });
      if (!r.ok) throw new Error(`staff email failed: ${String(r.error ?? "").slice(0, 200)}`);
      return `staff ${userId} emailed`;
    }
    case "rotate_owner": {
      if (!e.contact_id && !e.application_id) return "skip: nothing to assign";
      const pool = Array.isArray(p.userIds) && p.userIds.length
        ? p.userIds.map(String)
        : (await q(`SELECT id::text AS id FROM users WHERE active = true AND role IN ('Admin','Staff') AND id::text <> '${SYSTEM_USER}' AND (silo IS NULL OR silo = $1) ORDER BY created_at ASC`, [e.silo])).rows.map((r: any) => r.id);
      if (!pool.length) return "skip: no active staff";
      const n = await q(`UPDATE automation_rules SET rr_index = rr_index + 1 WHERE id = $1::uuid RETURNING rr_index`, [e.rule_id]);
      return setOwner(deps, e, pool[(Number(n.rows[0]?.rr_index ?? 1) - 1) % pool.length]);
    }
    case "assign_owner": {
      if (!e.contact_id && !e.application_id) return "skip: nothing to assign";
      if (!p.userId) return "skip: no user";
      return setOwner(deps, e, String(p.userId));
    }
    case "create_task": {
      const type = TASK_TYPES.includes(String(p.type ?? "").toUpperCase()) ? String(p.type).toUpperCase() : "TODO";
      const priority = TASK_PRIORITIES.includes(String(p.priority ?? "").toUpperCase()) ? String(p.priority).toUpperCase() : "MEDIUM";
      const hours = Math.max(0, Number(p.dueInHours ?? 24) || 0);
      const assignee = typeof p.assignee === "string" && /^[0-9a-f-]{36}$/i.test(p.assignee) ? p.assignee : null;
      const r = await q(
        `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source, source_ref_id)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval,
                 COALESCE($7::uuid, (SELECT owner_user_id FROM applications WHERE id::text = $8), (SELECT owner_id FROM contacts WHERE id::text = $9), ${FALLBACK_USER_SQL}),
                 $9::uuid, 'WORKFLOW', $10::uuid)
         RETURNING id::text AS id`,
        [e.silo, t(p.title || "Follow up").slice(0, 200), t(p.body || "") || null, type, priority, String(hours), assignee, e.application_id, e.contact_id, e.id]);
      return `task ${r.rows[0]?.id ?? ""}`;
    }
    case "set_contact_field": {
      if (!e.contact_id) return "skip: no contact";
      const field = String(p.field ?? "");
      if (!CONTACT_FIELDS_SETTABLE.includes(field)) return `skip: ${field} cannot be set`;
      const value = p.value === null || p.value === undefined ? null : t(p.value).slice(0, 300);
      await q(`UPDATE contacts SET ${field} = $2, updated_at = now() WHERE id::text = $1`, [e.contact_id, value]);
      e.context = { ...ctx, [field]: value };
      return `${field} = ${value ?? "(empty)"}`;
    }
    case "set_application_stage": {
      if (!e.application_id) return "skip: no application";
      if (!deps.setApplicationStage) throw new Error("stage changes are not configured");
      await deps.setApplicationStage(e.application_id, String(p.stage));
      return `stage ${p.stage}`;
    }
    case "add_tag":
    case "remove_tag": {
      const tag = String(p.tag ?? "").trim().slice(0, 60);
      if (!e.contact_id || !tag) return "skip: no contact or tag";
      if (node.action === "add_tag") await q(`UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY[$2::text]))), updated_at = now() WHERE id::text = $1`, [e.contact_id, tag]);
      else await q(`UPDATE contacts SET tags = array_remove(COALESCE(tags,'{}'), $2::text), updated_at = now() WHERE id::text = $1`, [e.contact_id, tag]);
      return `${node.action === "add_tag" ? "tag" : "untag"} ${tag}`;
    }
    case "add_to_list":
    case "remove_from_list": {
      if (!e.contact_id || !p.listId) return "skip: no contact or list";
      if (node.action === "add_to_list") {
        await q(`INSERT INTO automation_list_members (list_id, contact_id) SELECT l.id, $2::uuid FROM automation_lists l WHERE l.id::text = $1 ON CONFLICT (list_id, contact_id) DO NOTHING`, [p.listId, e.contact_id]);
        return `added to list ${p.listId}`;
      }
      await q(`DELETE FROM automation_list_members WHERE list_id::text = $1 AND contact_id = $2::uuid`, [p.listId, e.contact_id]);
      return `removed from list ${p.listId}`;
    }
    case "webhook": {
      let url: URL;
      try { url = new URL(String(p.url ?? "")); } catch { throw new Error("webhook URL is invalid"); }
      if (url.protocol !== "https:") throw new Error("webhook URL must be https");
      const fields = Array.isArray(p.includeFields) && p.includeFields.length ? p.includeFields.map(String) : ["contact_id", "application_id", "first_name", "email", "phone", "silo"];
      const payload: Record<string, unknown> = { workflowId: e.rule_id, enrollmentId: e.id, contactId: e.contact_id, applicationId: e.application_id };
      for (const f of fields) payload[f] = ctx[f] ?? null;
      const doFetch = deps.httpFetch ?? ((u: string, init: any) => fetch(u, init) as any);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      // BF_SERVER_v789_SSRF_GUARD - https only, every hop resolved and refused if internal,
      // max 3 manual redirects; each send is audited (workflow, host, field names - no values).
      let status: number | null = null;
      let finalHost = url.host;
      let outcome = "error";
      try {
        const { response: r, url: landed } = await ssrfSafeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal }, { httpsOnly: true, maxRedirects: 3, fetchImpl: doFetch as any });
        status = r.status;
        finalHost = landed.host;
        if (!r.ok) { outcome = "http_error"; console.warn("[automation] webhook failed", { url: url.host, status: r.status }); throw new Error(`webhook answered ${r.status}`); }
        outcome = "sent";
        return `webhook ${url.host} ${r.status}`;
      } catch (err: any) {
        if (err instanceof SsrfBlockedError) outcome = `blocked:${err.code}`;
        console.warn("[automation] webhook error", { url: url.host, message: err?.message ?? String(err) });
        throw new Error(err?.name === "AbortError" ? "webhook timed out after 10 s" : String(err?.message ?? err));
      } finally {
        clearTimeout(timer);
        await auditWebhookSend(deps, e, { host: url.host, finalHost, fields, status, outcome });
      }
    }
    case "enroll_workflow": {
      if (!p.workflowId) return "skip: no workflow";
      const { enrollContactInRule } = await import("./graphEngine.js");
      const id = await enrollContactInRule(deps, String(p.workflowId), { silo: e.silo, contactId: e.contact_id, applicationId: e.application_id, data: { source: "workflow", from_workflow: e.rule_id } });
      return id ? `enrolled in workflow ${p.workflowId}` : "skip: not enrolled (already enrolled or not found)";
    }
    default:
      return `skip: unknown action ${node.action}`;
  }
}
