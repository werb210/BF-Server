// BF_SERVER_v856_CRM_UNIFY - /api/crm/unified/* : the shared CRM features every silo's CRM screen uses (BF, SLF and
// KS here, by X-Silo / ?silo=; BI-Server serves the same contract at /api/v1/bi/crm/unified/*). Mounted inside
// routes/crm.ts after requireAuth + crm:read; changes need crm:write. Each silo's data stays its own.
//   GET    /tags                               core + silo + system tags and every tag in use (with counts)
//   POST   /tags/definitions {label}           Admin: add a silo tag      DELETE /tags/definitions/:slug
//   POST   /tags/apply {entity, ids, add, remove}   bulk or one record; system tags are refused
//   GET    /companies/:id/people               everyone linked to the company, grouped by role
//   POST   /companies/:id/people {contactId | contact:{name,email,phone}, role}     audited
//   POST   /companies/:id/people/remove {key, contactId, email}                     audited
//   GET    /companies/:id/details              company panel (record, else the latest application)
//   PATCH  /companies/:id/details {field: value}
//   GET    /duplicates/:entity/:id             possible duplicates of one record (the banner)
//   GET    /duplicates?entity=contact|company  every group (the Find duplicates page)
//   POST   /duplicates/dismiss {entity, ids}   "Not a duplicate"
//   GET    /merge/:entity/preview?ids=a,b      side-by-side values
//   POST   /merge/:entity {survivorId, loserIds, fields}   merge, then delete the losers (audited)
//   GET    /cleanup/scan?entity=contact|company   proposed changes only
//   POST   /cleanup/apply {changes}            ticked changes; before-images kept
//   GET    /cleanup/batches                    POST /cleanup/batches/:id/undo
//   GET    /ai-summary/:entity/:id             cached summary + sources (or null)
//   POST   /ai-summary/:entity/:id             generate now (rate limited)
//   GET    /contacts/:id/ks-licensee           Keystone licensee card (KS silo)
//   GET    /contacts/:id/survivor              where a merged record went (follows merged_into chains)
//   GET    /contacts/:id/applications          the contact's applications for the left panel (drafts collapsed)
//   GET    /contacts/:id/related               advisors linked to the contact, and clients the contact advises
//   POST   /duplicates/merge-placeholders {dryRun}   merge "Unknown (application started)" copies into the real record
//   POST   /people/backfill                    Admin: re-run the partner / guarantor / advisor contact backfill
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { normalizeTags, isSystemTag, tagCatalogue, tagFromLabel, CORE_TAGS } from "../modules/crmUnify/tags.js";
import { companyPeople, isPersonRole, personKey, ROLE_LABELS } from "../modules/crmUnify/people.js";
import { companyDetails, detailUpdates } from "../modules/crmUnify/companyDetails.js";
import { companyDuplicates, contactDuplicates, dismissDuplicate, duplicateGroups, mergePreview } from "../modules/crmUnify/duplicates.js";
import { mergeCompanies } from "../modules/crmUnify/companyMerge.js";
import { applyCleanup, listBatches, scanCleanup, undoCleanup, validChange } from "../modules/crmUnify/cleanup.js";
import { cachedSummary, generateSummary } from "../modules/crmUnify/aiSummary.js";
import { ksLicenseeInfo } from "../modules/crmUnify/ksLicensee.js";
import { resolveContactSurvivor } from "../modules/crmUnify/mergeChain.js";
import { backfillCrmPeople } from "../modules/crmUnify/peopleSync.js";
import { contactApplications, contactRelated } from "../modules/crmUnify/contactPanel.js";

const router = Router();
const requireWrite = requireCapability([CAPABILITIES.CRM_WRITE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const userIdOf = (req: any): string | null => {
  const id = req.user?.id ?? req.user?.userId ?? null;
  return isUuid(id) ? id : null;
};
const isAdmin = (req: any) => String(req.user?.role ?? "").toLowerCase() === "admin";
const entityOf = (v: unknown): "contact" | "company" | null => (v === "contact" || v === "company" ? v : null);

async function audit(req: any, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
  try {
    await recordAuditEvent({
      actorUserId: userIdOf(req), targetUserId: null, targetType, targetId, action, success: true,
      metadata: { silo: resolveSiloFromRequest(req), ...metadata },
      ip: req.ip ?? null, userAgent: typeof req.get === "function" ? req.get("user-agent") ?? null : null,
    });
  } catch (err) {
    console.warn("[crm-unified] audit write failed", { action, targetId, message: (err as Error)?.message });
  }
}

const summaryLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: rateLimitKeyFromRequest, // Azure sends ip:port; the library default rejects it
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

/* ---------- tags ---------- */

router.get("/tags", safeHandler(async (req: any, res: any) => {
  res.json({ ok: true, data: await tagCatalogue(pool, resolveSiloFromRequest(req)) });
}));

router.post("/tags/definitions", requireWrite, safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_only" });
  const def = tagFromLabel(req.body?.label);
  if (!def) return res.status(400).json({ ok: false, error: "label_required" });
  if (CORE_TAGS.some((t) => t.slug === def.slug)) return res.status(409).json({ ok: false, error: "already_a_shared_tag" });
  if (isSystemTag(def.slug)) return res.status(409).json({ ok: false, error: "reserved_system_tag" });
  const silo = resolveSiloFromRequest(req);
  await pool.query(
    `INSERT INTO crm_tag_definitions (silo, slug, label, created_by) VALUES ($1, $2, $3, $4::uuid)
     ON CONFLICT (silo, slug) DO UPDATE SET label = EXCLUDED.label`,
    [silo, def.slug, def.label, userIdOf(req)],
  );
  await audit(req, "crm.tag_definition_added", "crm_tag", def.slug, { label: def.label });
  res.status(201).json({ ok: true, data: def });
}));

router.delete("/tags/definitions/:slug", requireWrite, safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_only" });
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`DELETE FROM crm_tag_definitions WHERE silo = $1 AND slug = $2`, [silo, String(req.params.slug)]);
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  await audit(req, "crm.tag_definition_removed", "crm_tag", String(req.params.slug), {});
  res.json({ ok: true });
}));

router.post("/tags/apply", requireWrite, safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.body?.entity);
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter(isUuid) : [];
  const add = normalizeTags(req.body?.add ?? []);
  const remove = normalizeTags(req.body?.remove ?? []);
  if (!entity || !ids.length || (!add.length && !remove.length)) return res.status(400).json({ ok: false, error: "entity_ids_and_tags_required" });
  const sys = [...add, ...remove].filter(isSystemTag);
  if (sys.length) return res.status(400).json({ ok: false, error: "system_tag", message: `${sys.join(", ")} is set automatically and cannot be added or removed by hand.` });
  const table = entity === "contact" ? "contacts" : "companies";
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `UPDATE ${table}
        SET tags = bf_norm_tags(ARRAY(SELECT t FROM unnest(coalesce(tags, '{}'::text[]) || $2::text[]) t
                                       WHERE NOT (bf_norm_tag(t) = ANY($3::text[])))),
            updated_at = now()
      WHERE id = ANY($1::uuid[]) AND silo = $4`,
    [ids, add, remove, silo],
  );
  res.json({ ok: true, updated: r.rowCount ?? 0, added: add, removed: remove });
}));

/* ---------- company people ---------- */

router.get("/companies/:id/people", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const silo = resolveSiloFromRequest(req);
  const exists = await pool.query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = $2`, [id, silo]);
  if (!exists.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, data: { ...(await companyPeople(pool, id, silo)), roles: ROLE_LABELS } });
}));

router.post("/companies/:id/people", requireWrite, safeHandler(async (req: any, res: any) => {
  const companyId = String(req.params.id);
  const role = req.body?.role ?? "other";
  if (!isUuid(companyId)) return res.status(400).json({ ok: false, error: "invalid_id" });
  if (!isPersonRole(role)) return res.status(400).json({ ok: false, error: "invalid_role" });
  const silo = resolveSiloFromRequest(req);
  const company = (await pool.query(`SELECT id, name FROM companies WHERE id = $1::uuid AND silo = $2`, [companyId, silo])).rows[0];
  if (!company) return res.status(404).json({ ok: false, error: "not_found" });
  let contactId: string | null = isUuid(req.body?.contactId) ? req.body.contactId : null;
  let created = false;
  if (contactId) {
    const c = await pool.query(`SELECT id FROM contacts WHERE id = $1::uuid AND silo = $2`, [contactId, silo]);
    if (!c.rowCount) return res.status(404).json({ ok: false, error: "contact_not_found" });
  } else {
    const nc = req.body?.contact ?? {};
    const name = String(nc.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const email = String(nc.email ?? "").replace(/\s+/g, "").toLowerCase().slice(0, 200) || null;
    const phone = String(nc.phone ?? "").trim().slice(0, 40) || null;
    if (!name && !email) return res.status(400).json({ ok: false, error: "name_or_email_required" });
    const parts = name.split(" ");
    const ins = await pool.query(
      `INSERT INTO contacts (name, first_name, last_name, email, phone, silo, company_id, company_name, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $9::uuid) RETURNING id::text AS id`,
      [name || email, parts[0] || null, parts.slice(1).join(" ") || null, email, phone, silo, companyId, company.name ?? null, userIdOf(req)],
    );
    contactId = ins.rows[0].id as string;
    created = true;
  }
  await pool.query(
    `INSERT INTO crm_company_people (silo, company_id, contact_id, role, created_by) VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid)
     ON CONFLICT (company_id, contact_id) DO UPDATE SET role = EXCLUDED.role`,
    [silo, companyId, contactId, role, userIdOf(req)],
  );
  // HubSpot-style primary company: a contact without one gets this company.
  await pool.query(
    `UPDATE contacts SET company_id = $2::uuid, company_name = coalesce(nullif(company_name, ''), $3), updated_at = now()
      WHERE id = $1::uuid AND company_id IS NULL`,
    [contactId, companyId, company.name ?? null],
  );
  await pool.query(`DELETE FROM crm_company_people_hidden WHERE company_id = $1::uuid AND person_key = $2`, [companyId, `contact:${contactId}`]);
  await audit(req, "crm.company_person_added", "company", companyId, { contactId, role, created });
  res.status(201).json({ ok: true, data: { contactId, role, created } });
}));

router.post("/companies/:id/people/remove", requireWrite, safeHandler(async (req: any, res: any) => {
  const companyId = String(req.params.id);
  if (!isUuid(companyId)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const silo = resolveSiloFromRequest(req);
  const exists = await pool.query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = $2`, [companyId, silo]);
  if (!exists.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  const contactId = isUuid(req.body?.contactId) ? req.body.contactId : null;
  const email = typeof req.body?.email === "string" && req.body.email.includes("@") ? req.body.email.trim().toLowerCase() : null;
  const key = typeof req.body?.key === "string" && req.body.key.trim() ? req.body.key.trim().slice(0, 300) : personKey({ contactId, email, name: req.body?.name });
  const keys = Array.from(new Set([key, contactId ? `contact:${contactId}` : null, email ? `email:${email}` : null].filter(Boolean) as string[]));
  for (const k of keys) {
    await pool.query(
      `INSERT INTO crm_company_people_hidden (company_id, person_key, silo, created_by) VALUES ($1::uuid, $2, $3, $4::uuid)
       ON CONFLICT (company_id, person_key) DO NOTHING`,
      [companyId, k, silo, userIdOf(req)],
    );
  }
  if (contactId) {
    await pool.query(`DELETE FROM crm_company_people WHERE company_id = $1::uuid AND contact_id = $2::uuid`, [companyId, contactId]);
    await pool.query(`UPDATE contacts SET company_id = NULL, updated_at = now() WHERE id = $1::uuid AND company_id = $2::uuid AND silo = $3`, [contactId, companyId, silo]);
  }
  await audit(req, "crm.company_person_removed", "company", companyId, { contactId, keys });
  res.json({ ok: true });
}));

/* ---------- company details ---------- */

router.get("/companies/:id/details", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const out = await companyDetails(pool, id, resolveSiloFromRequest(req));
  if (!out) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, data: { fields: out.fields, tags: Array.isArray(out.company.tags) ? out.company.tags : [] } });
}));

router.patch("/companies/:id/details", requireWrite, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const parsed = detailUpdates(req.body ?? {});
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error, field: parsed.field });
  if (!parsed.sets.length) return res.json({ ok: true, updated: 0 });
  const silo = resolveSiloFromRequest(req);
  const cols = parsed.sets.map(([c]) => c);
  const r = await pool.query(
    `UPDATE companies SET ${cols.map((c, i) => `"${c}" = $${i + 3}`).join(", ")}, updated_at = now() WHERE id = $1::uuid AND silo = $2`,
    [id, silo, ...parsed.sets.map(([, v]) => v)],
  );
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  if (cols.includes("name")) {
    await pool.query(`UPDATE contacts SET company_name = (SELECT name FROM companies WHERE id = $1::uuid) WHERE company_id = $1::uuid`, [id]);
  }
  const out = await companyDetails(pool, id, silo);
  res.json({ ok: true, data: { fields: out?.fields ?? [] } });
}));

/* ---------- duplicates and merge ---------- */

router.get("/duplicates/:entity/:id", safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.params.entity);
  const id = String(req.params.id);
  if (!entity || !isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_request" });
  const silo = resolveSiloFromRequest(req);
  if (entity === "contact") {
    // A merged record is never offered merges: tell the page where the surviving record is instead.
    const info = await resolveContactSurvivor(pool, id, silo);
    if (info.merged) return res.json({ ok: true, data: { count: 0, candidates: [], mergedInto: info.id, mergedIntoName: info.name } });
    if (info.archived) return res.json({ ok: true, data: { count: 0, candidates: [], archived: true } });
  }
  const candidates = entity === "contact" ? await contactDuplicates(pool, id, silo) : await companyDuplicates(pool, id, silo);
  res.json({ ok: true, data: { count: candidates.length, candidates } });
}));

router.get("/duplicates", safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.query.entity) ?? "contact";
  res.json({ ok: true, data: { entity, groups: await duplicateGroups(pool, resolveSiloFromRequest(req), entity) } });
}));

router.post("/duplicates/dismiss", requireWrite, safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.body?.entity);
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter(isUuid) : [];
  if (!entity || ids.length < 2) return res.status(400).json({ ok: false, error: "entity_and_two_ids_required" });
  const silo = resolveSiloFromRequest(req);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) await dismissDuplicate(pool, silo, entity, ids[i]!, ids[j]!, userIdOf(req));
  res.json({ ok: true });
}));

router.get("/merge/:entity/preview", safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.params.entity);
  const ids = String(req.query.ids ?? "").split(",").map((x) => x.trim()).filter(isUuid);
  if (!entity || ids.length < 2) return res.status(400).json({ ok: false, error: "two_ids_required" });
  res.json({ ok: true, data: await mergePreview(pool, resolveSiloFromRequest(req), entity, Array.from(new Set(ids)).slice(0, 5)) });
}));

router.post("/merge/:entity", requireWrite, safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.params.entity);
  const survivorId = req.body?.survivorId;
  const loserIds: string[] = Array.isArray(req.body?.loserIds) ? req.body.loserIds.filter(isUuid) : [];
  if (!entity || !isUuid(survivorId) || !loserIds.length) return res.status(400).json({ ok: false, error: "survivorId_and_loserIds_required" });
  if (loserIds.includes(survivorId)) return res.status(400).json({ ok: false, error: "cannot_merge_into_itself" });
  const silo = resolveSiloFromRequest(req);
  if (entity === "contact") {
    // Reuses the contact merge (routes/crm/contactMerge.ts) with the values staff chose, and deletes the losers.
    const { mergeContactsHandler } = await import("./crm/contactMerge.js");
    req.body = { survivorId, loserIds, fields: req.body?.fields ?? null, deleteLosers: true };
    const original = res.json.bind(res);
    res.json = (payload: any) => {
      if (payload?.ok) void audit(req, "crm.contacts_merged", "contact", survivorId, { loserIds, fields: Object.keys(req.body?.fields ?? {}) });
      return original(payload);
    };
    return mergeContactsHandler(req, res);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await mergeCompanies(client, { silo, survivorId, loserIds, fields: req.body?.fields, userId: userIdOf(req) });
    await client.query("COMMIT");
    await audit(req, "crm.companies_merged", "company", survivorId, { loserIds, moved: out.moved });
    res.json({ ok: true, data: out });
  } catch (err: any) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => console.warn("[crm-unified] merge rollback failed", (rbErr as Error)?.message));
    console.error("[crm-unified] company merge failed", { survivorId, loserIds, message: err?.message });
    res.status(Number(err?.status) || 500).json({ ok: false, error: err?.message ?? "merge_failed" });
  } finally {
    client.release();
  }
}));

/* ---------- data clean-up ---------- */

router.get("/cleanup/scan", safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.query.entity) ?? "contact";
  const changes = await scanCleanup(pool, resolveSiloFromRequest(req), entity);
  res.json({ ok: true, data: { entity, changes } });
}));

router.post("/cleanup/apply", requireWrite, safeHandler(async (req: any, res: any) => {
  const list: unknown[] = Array.isArray(req.body?.changes) ? req.body.changes : [];
  const changes = list.filter(validChange);
  if (!changes.length) return res.status(400).json({ ok: false, error: "no_valid_changes" });
  if (changes.length > 5000) return res.status(400).json({ ok: false, error: "too_many_changes" });
  const silo = resolveSiloFromRequest(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await applyCleanup(client, silo, changes, userIdOf(req));
    await client.query("COMMIT");
    await audit(req, "crm.cleanup_applied", "crm_cleanup_batch", out.batchId, { applied: out.applied, skipped: out.skipped.length });
    res.json({ ok: true, data: out });
  } catch (err: any) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => console.warn("[crm-unified] cleanup rollback failed", (rbErr as Error)?.message));
    throw err;
  } finally {
    client.release();
  }
}));

router.get("/cleanup/batches", safeHandler(async (req: any, res: any) => {
  res.json({ ok: true, data: await listBatches(pool, resolveSiloFromRequest(req)) });
}));

router.post("/cleanup/batches/:id/undo", requireWrite, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await undoCleanup(client, resolveSiloFromRequest(req), id, userIdOf(req));
    if (!out.ok) { await client.query("ROLLBACK"); return res.status(out.status).json({ ok: false, error: out.error }); }
    await client.query("COMMIT");
    await audit(req, "crm.cleanup_undone", "crm_cleanup_batch", id, { restored: out.restored, skipped: out.skipped.length });
    res.json({ ok: true, data: out });
  } catch (err: any) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => console.warn("[crm-unified] undo rollback failed", (rbErr as Error)?.message));
    throw err;
  } finally {
    client.release();
  }
}));

/* ---------- AI summary ---------- */

router.get("/ai-summary/:entity/:id", safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.params.entity);
  const id = String(req.params.id);
  if (!entity || !isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_request" });
  res.json({ ok: true, data: await cachedSummary(pool, resolveSiloFromRequest(req), entity, id) });
}));

router.post("/ai-summary/:entity/:id", summaryLimiter, safeHandler(async (req: any, res: any) => {
  const entity = entityOf(req.params.entity);
  const id = String(req.params.id);
  if (!entity || !isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_request" });
  const brief = await import("../services/crm/contactBrief.js");
  const out = await generateSummary(pool, {
    brief: (e, x, silo) => (e === "contact" ? brief.contactBrief(x, silo) : brief.companyBrief(x, silo)),
    background: (domain) => brief.companyBackground(domain),
  }, resolveSiloFromRequest(req), entity, id, userIdOf(req));
  if (!out) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, data: out });
}));

/* ---------- Keystone licensee ---------- */

router.get("/contacts/:id/survivor", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  res.json({ ok: true, data: await resolveContactSurvivor(pool, id, resolveSiloFromRequest(req)) });
}));

router.get("/contacts/:id/applications", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  res.json({ ok: true, data: await contactApplications(pool, id, resolveSiloFromRequest(req)) });
}));

router.get("/contacts/:id/related", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  res.json({ ok: true, data: await contactRelated(pool, id, resolveSiloFromRequest(req)) });
}));

// Placeholder contacts ("Unknown (application started)") that share a phone or email with a real record: each group
// is merged into its suggested survivor (the real record). dryRun lists what would happen.
router.post("/duplicates/merge-placeholders", requireWrite, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const groups = (await duplicateGroups(pool, silo, "contact", 1000))
    .filter((g) => g.placeholders > 0 && !g.records.find((r: any) => r.id === g.survivorId && r.placeholder));
  const plan = groups.map((g) => ({
    survivorId: g.survivorId,
    survivorName: (g.records.find((r: any) => r.id === g.survivorId) as any)?.name ?? null,
    loserIds: g.records.filter((r: any) => r.placeholder && r.id !== g.survivorId).map((r: any) => String(r.id)),
  })).filter((x) => x.loserIds.length > 0);
  if (req.body?.dryRun === true) return res.json({ ok: true, data: { groups: plan.length, contacts: plan.reduce((n, x) => n + x.loserIds.length, 0), plan } });
  const { mergeContactsHandler } = await import("./crm/contactMerge.js");
  let merged = 0;
  const failed: Array<{ survivorId: string; error: string }> = [];
  for (const item of plan) {
    let result: any = null;
    let status = 200;
    const fakeRes: any = { status(code: number) { status = code; return fakeRes; }, json(payload: any) { result = payload; return fakeRes; } };
    const subReq = Object.create(req); // keeps the request's user, headers and methods
    subReq.body = { survivorId: item.survivorId, loserIds: item.loserIds, deleteLosers: true };
    await mergeContactsHandler(subReq, fakeRes);
    if (status < 300 && result?.ok) merged += item.loserIds.length;
    else failed.push({ survivorId: item.survivorId, error: String(result?.error ?? "merge_failed") });
  }
  await audit(req, "crm.placeholders_merged", "contact", plan[0]?.survivorId ?? "00000000-0000-0000-0000-000000000000", { groups: plan.length, merged, failed: failed.length });
  res.json({ ok: true, data: { groups: plan.length, merged, failed } });
}));

router.post("/people/backfill", requireWrite, safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_only" });
  const out = await backfillCrmPeople(pool);
  await audit(req, "crm.people_backfill", "application", "00000000-0000-0000-0000-000000000000", out);
  res.json({ ok: true, data: out });
}));

router.get("/contacts/:id/ks-licensee", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  if (resolveSiloFromRequest(req) !== "KS") return res.json({ ok: true, data: null });
  res.json({ ok: true, data: await ksLicenseeInfo(pool, id) });
}));

export default router;
