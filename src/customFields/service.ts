// BF_SERVER_v870_CRM_DATA_MODEL - custom field definitions and record values in the database (ported from KS-server
// #39). Definitions belong to one silo (BF, BI or SLF); a record's values are checked against its own silo's fields.
import type { Q } from "../settingsPack/common.js";
import {
  LIMITS, mergeValues, validateDefinition, validateValues, type CleanDefinition, type DefinitionInput, type FieldDefinition,
  type ObjectType,
} from "./definitions.js";

export const RECORD_TABLE: Record<ObjectType, { table: string; idCast: string }> = {
  contact: { table: "contacts", idCast: "uuid" },
  company: { table: "companies", idCast: "uuid" },
  application: { table: "applications", idCast: "text" },
};

const SILOS = new Set(["BF", "BI", "SLF"]);
export function cleanSilo(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  return SILOS.has(s) ? s : "BF";
}

const COLS = `id::text AS id, silo, object_type, name, label, field_type, options, required, group_name, description, sort_order,
              archived_at, created_at, updated_at`;

function rowToDef(r: any): FieldDefinition {
  return {
    id: String(r.id), silo: cleanSilo(r.silo), object_type: r.object_type, name: String(r.name), label: String(r.label), field_type: r.field_type,
    options: Array.isArray(r.options) ? r.options : [], required: Boolean(r.required), group_name: r.group_name ?? null,
    description: r.description ?? null, sort_order: Number(r.sort_order ?? 0), archived_at: r.archived_at ?? null,
    ...(r.created_at ? { created_at: r.created_at, updated_at: r.updated_at } : {}),
  } as FieldDefinition;
}

// Definitions change rarely and are read on every list request: cache them for a short time per process.
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; defs: FieldDefinition[] }>();
export function clearCustomFieldCache(): void {
  cache.clear();
}

function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

/** Every definition of an object type in a silo (archived too), in display order. [] before the migration has run. */
export async function listDefinitions(
  db: Q, object: ObjectType, silo: unknown, opts: { includeArchived?: boolean; fresh?: boolean } = {},
): Promise<FieldDefinition[]> {
  const s = cleanSilo(silo);
  const key = `${s}|${object}`;
  const hit = cache.get(key);
  let defs: FieldDefinition[];
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) defs = hit.defs;
  else {
    try {
      const r = await db.query(
        `SELECT ${COLS} FROM custom_field_definitions WHERE object_type = $1 AND silo = $2
          ORDER BY COALESCE(group_name, ''), sort_order, created_at`,
        [object, s],
      );
      defs = (r?.rows ?? []).map(rowToDef);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      console.warn("[custom-fields] definitions table missing; treating as no fields");
      defs = [];
    }
    cache.set(key, { at: Date.now(), defs });
  }
  return opts.includeArchived ? defs : defs.filter((d) => !d.archived_at);
}

export async function getDefinition(db: Q, id: string): Promise<FieldDefinition | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`SELECT ${COLS} FROM custom_field_definitions WHERE id = $1`, [id]);
  return r.rows[0] ? rowToDef(r.rows[0]) : null;
}

export type DefinitionWrite = { ok: true; definition: FieldDefinition } | { ok: false; status: number; errors: string[] };

export async function createDefinition(db: Q, object: ObjectType, silo: unknown, input: DefinitionInput, actor: string | null): Promise<DefinitionWrite> {
  const s = cleanSilo(silo);
  const v = validateDefinition(input);
  if (!v.ok) return { ok: false, status: 400, errors: v.errors };
  const counts = await db.query(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active, count(*)::int AS total
       FROM custom_field_definitions WHERE object_type = $1 AND silo = $2`,
    [object, s],
  );
  const active = Number(counts.rows[0]?.active ?? 0);
  const total = Number(counts.rows[0]?.total ?? 0);
  if (active >= LIMITS.activePerObject) return { ok: false, status: 409, errors: [`You can have at most ${LIMITS.activePerObject} fields in use on ${object === "company" ? "companies" : `${object}s`}. Archive one first.`] };
  if (total >= LIMITS.totalPerObject) return { ok: false, status: 409, errors: [`This record type already has ${LIMITS.totalPerObject} fields, including archived ones.`] };
  const c: CleanDefinition = v.value;
  const order = input.sort_order === undefined
    ? Number((await db.query(`SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM custom_field_definitions WHERE object_type = $1 AND silo = $2`, [object, s])).rows[0]?.n ?? 0)
    : c.sort_order;
  try {
    const r = await db.query(
      `INSERT INTO custom_field_definitions (silo, object_type, name, label, field_type, options, required, group_name, description, sort_order, created_by, updated_by)
       VALUES ($11, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $10)
       RETURNING ${COLS}`,
      [object, c.name, c.label, c.field_type, JSON.stringify(c.options), c.required, c.group_name, c.description, order, actor, s],
    );
    clearCustomFieldCache();
    return { ok: true, definition: rowToDef(r.rows[0]) };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, status: 409, errors: [`A field with the internal name "${c.name}" already exists (it may be archived).`] };
    throw err;
  }
}

export async function updateDefinition(db: Q, existing: FieldDefinition, input: DefinitionInput, actor: string | null): Promise<DefinitionWrite> {
  const v = validateDefinition(input, existing);
  if (!v.ok) return { ok: false, status: 400, errors: v.errors };
  const c = v.value;
  const r = await db.query(
    `UPDATE custom_field_definitions
        SET label = $2, field_type = $3, options = $4::jsonb, required = $5, group_name = $6, description = $7, sort_order = $8,
            updated_by = $9, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [existing.id, c.label, c.field_type, JSON.stringify(c.options), c.required, c.group_name, c.description, c.sort_order, actor],
  );
  if (existing.field_type === "single_select" && c.field_type === "multi_select") {
    // Stored values become one-item lists so they stay valid (only on this silo's records).
    const t = RECORD_TABLE[existing.object_type].table;
    await db.query(
      `UPDATE ${t} SET custom_fields = jsonb_set(custom_fields, ARRAY[$1::text], jsonb_build_array(custom_fields->$1))
        WHERE jsonb_typeof(custom_fields->$1) = 'string' AND silo = $2`,
      [existing.name, cleanSilo(existing.silo)],
    );
  }
  clearCustomFieldCache();
  return { ok: true, definition: rowToDef(r.rows[0]) };
}

export async function setArchived(db: Q, existing: FieldDefinition, archived: boolean, actor: string | null): Promise<DefinitionWrite> {
  if (!archived) {
    const active = await db.query(
      `SELECT count(*)::int AS n FROM custom_field_definitions WHERE object_type = $1 AND silo = $2 AND archived_at IS NULL`,
      [existing.object_type, cleanSilo(existing.silo)],
    );
    if (Number(active.rows[0]?.n ?? 0) >= LIMITS.activePerObject) return { ok: false, status: 409, errors: [`You already have ${LIMITS.activePerObject} fields in use. Archive one first.`] };
  }
  const r = await db.query(
    `UPDATE custom_field_definitions SET archived_at = ${archived ? "COALESCE(archived_at, now())" : "NULL"}, updated_by = $2, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [existing.id, actor],
  );
  clearCustomFieldCache();
  return { ok: true, definition: rowToDef(r.rows[0]) };
}

/** New sort_order for the given ids (10, 20, 30...), in that order. Ids of another object type or silo are ignored. */
export async function reorder(db: Q, object: ObjectType, silo: unknown, ids: string[]): Promise<void> {
  const clean = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, LIMITS.totalPerObject);
  if (!clean.length) return;
  await db.query(
    `UPDATE custom_field_definitions d SET sort_order = x.ord * 10, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ord)
      WHERE d.id = x.id AND d.object_type = $1 AND d.silo = $3`,
    [object, clean, cleanSilo(silo)],
  );
  clearCustomFieldCache();
}

export type ValuesWrite =
  | { ok: true; custom_fields: Record<string, unknown>; changed: string[] }
  | { ok: false; status: number; errors: Array<{ field: string; error: string }> };

/**
 * Validates values and writes them onto one record (merged into what it holds; null clears), against the fields of
 * the record's own silo. requireAll checks required fields (the portal's edit form). 404 when the record does not exist.
 */
export async function writeRecordValues(
  db: Q, object: ObjectType, recordId: string, input: unknown, opts: { requireAll?: boolean } = {},
): Promise<ValuesWrite> {
  const { table, idCast } = RECORD_TABLE[object];
  if (idCast === "uuid" && !/^[0-9a-f-]{36}$/i.test(recordId)) return { ok: false, status: 404, errors: [{ field: "", error: "Record not found." }] };
  const cur = await db.query(`SELECT custom_fields, silo FROM ${table} WHERE id = $1::${idCast}`, [recordId]);
  if (!cur.rows[0]) return { ok: false, status: 404, errors: [{ field: "", error: "Record not found." }] };
  const current = (cur.rows[0].custom_fields ?? {}) as Record<string, unknown>;
  const defs = await listDefinitions(db, object, cur.rows[0].silo, { includeArchived: true });
  const check = validateValues(defs, input, current, opts);
  if (check.errors.length) return { ok: false, status: 400, errors: check.errors };
  const changed = Object.keys(check.changes);
  if (!changed.length) return { ok: true, custom_fields: current, changed };
  const set = Object.fromEntries(Object.entries(check.changes).filter(([, v]) => v !== null));
  const removed = Object.entries(check.changes).filter(([, v]) => v === null).map(([k]) => k);
  const r = await db.query(
    `UPDATE ${table} SET custom_fields = (COALESCE(custom_fields, '{}'::jsonb) - $2::text[]) || $3::jsonb, updated_at = now()
      WHERE id = $1::${idCast} RETURNING custom_fields`,
    [recordId, removed, JSON.stringify(set)],
  );
  return { ok: true, custom_fields: (r.rows[0]?.custom_fields ?? mergeValues(current, check.changes)) as Record<string, unknown>, changed };
}

/** Validates values for a record that is about to be created in a silo (no current values). */
export async function checkNewRecordValues(db: Q, object: ObjectType, silo: unknown, input: unknown, opts: { requireAll?: boolean } = {}) {
  const defs = await listDefinitions(db, object, silo, { includeArchived: true });
  const check = validateValues(defs, input, {}, opts);
  return { ...check, value: mergeValues({}, check.changes) };
}
