// BF_SERVER_v870_CRM_DATA_MODEL - /api/custom-fields: custom fields on contacts, companies and applications (ported
// from KS-server #39). Every route works in the request's silo (?silo= / X-Silo, as the rest of the CRM).
//   GET    /                                   field types, limits and every object's fields (staff)
//   GET    /:object                            the object's fields, ?include_archived=1 (staff)
//   POST   /:object                            create (Admin)          { label, name?, field_type, options?, required?, group_name?, description? }
//   PATCH  /:object/:fieldId                   change (Admin)          same fields; the internal name and object never change
//   POST   /:object/:fieldId/archive | /unarchive   (Admin)            archived fields keep their values but are hidden
//   PUT    /:object/order                      (Admin)                 { ids: [...] } display order
//   GET    /:object/records/:recordId          the record's fields and values (staff who may see the record)
//   PUT    /:object/records/:recordId          { values: { name: value | null } } (staff with CRM write, record visible)
// Fields are never deleted: archive instead.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { FIELD_TYPES, FIELD_TYPE_LABEL, LIMITS, OBJECT_TYPES, isObjectType, type ObjectType } from "../customFields/definitions.js";
import {
  createDefinition, getDefinition, listDefinitions, reorder, setArchived, updateDefinition, writeRecordValues, RECORD_TABLE,
} from "../customFields/service.js";
import { canSeeRecord, scopeForRequest } from "../visibility/scope.js";

const router = Router();
router.use(requireAuth);
const db = () => pool as unknown as Q;

function objectOr404(req: any, res: any): ObjectType | null {
  const o = String(req.params.object ?? "");
  if (!isObjectType(o)) { res.status(404).json({ ok: false, error: "unknown_object", message: "Use contact, company or application." }); return null; }
  return o;
}

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const objects: Record<string, unknown> = {};
  for (const o of OBJECT_TYPES) objects[o] = await listDefinitions(db(), o, silo, { includeArchived: true });
  res.json({
    ok: true,
    field_types: FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABEL[t] })),
    silo,
    limits: { active_per_object: LIMITS.activePerObject, total_per_object: LIMITS.totalPerObject, options_per_field: LIMITS.optionsPerField },
    objects,
  });
}));

router.get("/:object", safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const includeArchived = ["1", "true"].includes(String(req.query.include_archived ?? ""));
  res.json({ ok: true, fields: await listDefinitions(db(), object, resolveSiloFromRequest(req), { includeArchived, fresh: true }) });
}));

router.post("/:object", requireAdmin, safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const r = await createDefinition(db(), object, resolveSiloFromRequest(req), req.body ?? {}, actorId(req));
  if (!r.ok) return res.status(r.status).json({ ok: false, error: "invalid_field", message: r.errors.join(" "), errors: r.errors });
  await auditFor(req, "custom_field.created", { object, name: r.definition.name, field_type: r.definition.field_type, silo: resolveSiloFromRequest(req) }, { type: "custom_field", id: r.definition.id });
  res.status(201).json({ ok: true, field: r.definition });
}));

router.put("/:object/order", requireAdmin, safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  await reorder(db(), object, resolveSiloFromRequest(req), ids);
  await auditFor(req, "custom_field.reordered", { object, count: ids.length, silo: resolveSiloFromRequest(req) }, { type: "custom_field", id: null });
  res.json({ ok: true, fields: await listDefinitions(db(), object, resolveSiloFromRequest(req), { includeArchived: true, fresh: true }) });
}));

async function fieldFor(req: any, res: any, object: ObjectType) {
  const def = await getDefinition(db(), String(req.params.fieldId ?? ""));
  if (!def || def.object_type !== object || def.silo !== resolveSiloFromRequest(req)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return def;
}

router.patch("/:object/:fieldId", requireAdmin, safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const def = await fieldFor(req, res, object);
  if (!def) return;
  const r = await updateDefinition(db(), def, req.body ?? {}, actorId(req));
  if (!r.ok) return res.status(r.status).json({ ok: false, error: "invalid_field", message: r.errors.join(" "), errors: r.errors });
  await auditFor(req, "custom_field.updated", { object, name: def.name, changes: Object.keys(req.body ?? {}), silo: resolveSiloFromRequest(req) }, { type: "custom_field", id: def.id });
  res.json({ ok: true, field: r.definition });
}));

for (const [path, archived] of [["archive", true], ["unarchive", false]] as const) {
  router.post(`/:object/:fieldId/${path}`, requireAdmin, safeHandler(async (req: any, res: any) => {
    const object = objectOr404(req, res);
    if (!object) return;
    const def = await fieldFor(req, res, object);
    if (!def) return;
    const r = await setArchived(db(), def, archived, actorId(req));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "invalid_field", message: r.errors.join(" "), errors: r.errors });
    await auditFor(req, archived ? "custom_field.archived" : "custom_field.unarchived", { object, name: def.name }, { type: "custom_field", id: def.id });
    res.json({ ok: true, field: r.definition });
  }));
}

async function recordFor(req: any, res: any, object: ObjectType): Promise<string | null> {
  const id = String(req.params.recordId ?? "");
  const scope = await scopeForRequest(req, db());
  if (!(await canSeeRecord(db(), scope, object, id))) {
    // canSeeRecord answers true for "all" scopes without reading: confirm the record exists.
    res.status(404).json({ ok: false, error: "not_found" });
    return null;
  }
  return id;
}

router.get("/:object/records/:recordId", safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const id = await recordFor(req, res, object);
  if (!id) return;
  const { table, idCast } = RECORD_TABLE[object];
  if (idCast === "uuid" && !/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const r = await pool.query(`SELECT custom_fields, silo FROM ${table} WHERE id = $1::${idCast}`, [id]);
  if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
  const values = (r.rows[0].custom_fields ?? {}) as Record<string, unknown>;
  // The record's own silo decides which fields it has.
  const defs = await listDefinitions(db(), object, r.rows[0].silo, { includeArchived: true });
  // Archived fields show only where the record still holds a value (read-only in the portal).
  const fields = defs.filter((d) => !d.archived_at || Object.prototype.hasOwnProperty.call(values, d.name));
  res.json({ ok: true, fields, values });
}));

router.put("/:object/records/:recordId", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  const object = objectOr404(req, res);
  if (!object) return;
  const id = await recordFor(req, res, object);
  if (!id) return;
  const { idCast } = RECORD_TABLE[object];
  if (idCast === "uuid" && !/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const w = await writeRecordValues(db(), object, id, req.body?.values ?? {}, { requireAll: req.body?.validate_required !== false });
  if (!w.ok) return res.status(w.status).json({ ok: false, error: w.status === 404 ? "not_found" : "invalid_values", message: w.errors.map((e) => e.error).join(" "), errors: w.errors });
  if (w.changed.length) await auditFor(req, "custom_field.values_changed", { fields: w.changed }, { type: object, id });
  res.json({ ok: true, values: w.custom_fields });
}));

export default router;
