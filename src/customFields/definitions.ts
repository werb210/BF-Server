// BF_SERVER_v870_CRM_DATA_MODEL - custom fields (Settings > Properties): the rules for a field definition and for the
// values stored under it (ported from KS-server #39, BF_SERVER_v870_CRM_DATA_MODEL). Pure (no database):
// src/customFields/service.ts reads and writes, src/routes/customFields.ts is the API. Each silo (BF, BI, SLF) has its
// own fields: a BF contact never shows a field defined for BI.
//
// A record keeps its values in its own custom_fields jsonb column, keyed by the field's internal name:
//   text, long_text, url, email, phone, date ("YYYY-MM-DD"), single_select (option value) -> string
//   number, money -> number            multi_select -> string[] of option values            checkbox -> boolean
// An empty value removes the key. A field's internal name never changes once created, so stored values always line up.

export const OBJECT_TYPES = ["contact", "company", "application"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const FIELD_TYPES = [
  "text", "long_text", "number", "money", "date", "single_select", "multi_select", "checkbox", "url", "email", "phone",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Single-line text", long_text: "Multi-line text", number: "Number", money: "Money", date: "Date",
  single_select: "Dropdown (pick one)", multi_select: "Multiple checkboxes (pick any)", checkbox: "Yes / no",
  url: "Website address", email: "Email address", phone: "Phone number",
};

export const LIMITS = {
  /** Fields in use per object type (archived ones do not count). */
  activePerObject: 100,
  /** Every field ever created per object type, archived included. */
  totalPerObject: 300,
  optionsPerField: 200,
  labelChars: 80,
  groupChars: 60,
  descriptionChars: 300,
  optionChars: 100,
  textChars: 1000,
  longTextChars: 20_000,
  urlChars: 2000,
};

export const SELECT_TYPES: ReadonlySet<FieldType> = new Set(["single_select", "multi_select"]);
/** Type changes that keep every stored value valid. Anything else needs a new field. */
const COMPATIBLE: Record<string, FieldType[]> = {
  text: ["long_text"], long_text: ["text"], number: ["money"], money: ["number"], single_select: ["multi_select"],
};

export function isObjectType(v: unknown): v is ObjectType {
  return typeof v === "string" && (OBJECT_TYPES as readonly string[]).includes(v);
}
export function isFieldType(v: unknown): v is FieldType {
  return typeof v === "string" && (FIELD_TYPES as readonly string[]).includes(v);
}
export function canChangeType(from: FieldType, to: FieldType): boolean {
  return from === to || (COMPATIBLE[from] ?? []).includes(to);
}

export type FieldOption = { value: string; label: string };

export type FieldDefinition = {
  id: string;
  object_type: ObjectType;
  name: string;
  label: string;
  field_type: FieldType;
  options: FieldOption[];
  required: boolean;
  group_name: string | null;
  description: string | null;
  sort_order: number;
  archived_at: string | Date | null;
  /** The silo the field belongs to (BF, BI or SLF). */
  silo?: string;
};

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** "Broker licence #" -> "broker_licence". Always a valid internal name (falls back to "field"). */
export function slugifyName(label: string): string {
  const s = String(label ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  const named = /^[a-z]/.test(s) ? s : `f_${s}`.replace(/_+$/g, "");
  return NAME_RE.test(named) ? named : "field";
}

function optionValue(label: string): string {
  return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "option";
}

export type DefinitionInput = {
  label?: unknown; name?: unknown; field_type?: unknown; options?: unknown; required?: unknown;
  group_name?: unknown; description?: unknown; sort_order?: unknown;
};

export type CleanDefinition = {
  label: string; name: string; field_type: FieldType; options: FieldOption[]; required: boolean;
  group_name: string | null; description: string | null; sort_order: number;
};

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Options from ["Gold", "Silver"] or [{ value, label }]. Values are unique; labels are what staff see. */
export function cleanOptions(raw: unknown): { options: FieldOption[]; errors: string[] } {
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { options: [], errors };
  if (!Array.isArray(raw)) return { options: [], errors: ["Options must be a list."] };
  const out: FieldOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    const label = str(typeof o === "object" && o !== null ? (o as any).label ?? (o as any).value : o);
    if (!label) continue;
    if (label.length > LIMITS.optionChars) { errors.push(`Option "${label.slice(0, 20)}..." is longer than ${LIMITS.optionChars} characters.`); continue; }
    const value = typeof o === "object" && o !== null && str((o as any).value) ? str((o as any).value).slice(0, 100) : optionValue(label);
    if (seen.has(value)) { errors.push(`Option "${label}" is listed twice.`); continue; }
    seen.add(value);
    out.push({ value, label });
  }
  if (out.length > LIMITS.optionsPerField) errors.push(`A field can have at most ${LIMITS.optionsPerField} options.`);
  return { options: out, errors };
}

/**
 * Validates a new definition (existing = undefined) or a change to one. On a change the internal name and object type
 * never change, and the type may only change to a compatible one.
 */
export function validateDefinition(input: DefinitionInput, existing?: FieldDefinition):
  { ok: true; value: CleanDefinition } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const label = input.label !== undefined ? str(input.label) : existing?.label ?? "";
  if (!label) errors.push("Give the field a label.");
  if (label.length > LIMITS.labelChars) errors.push(`The label can be at most ${LIMITS.labelChars} characters.`);

  let name = existing?.name ?? (str(input.name) || slugifyName(label));
  if (existing && input.name !== undefined && str(input.name) && str(input.name) !== existing.name) {
    errors.push("The internal name can't be changed once the field exists.");
    name = existing.name;
  }
  if (!NAME_RE.test(name)) errors.push("The internal name must start with a letter and use only lower-case letters, numbers and _ (64 at most).");

  const rawType = input.field_type !== undefined ? input.field_type : existing?.field_type;
  let field_type: FieldType = "text";
  if (!isFieldType(rawType)) errors.push("Choose a field type.");
  else {
    field_type = rawType;
    if (existing && !canChangeType(existing.field_type, field_type)) {
      errors.push(`A ${FIELD_TYPE_LABEL[existing.field_type]} field can't become ${FIELD_TYPE_LABEL[field_type]}. Create a new field instead.`);
    }
  }

  const opt = input.options !== undefined ? cleanOptions(input.options) : { options: existing?.options ?? [], errors: [] };
  errors.push(...opt.errors);
  if (SELECT_TYPES.has(field_type) && opt.options.length === 0) errors.push("Add at least one option.");
  if (existing && SELECT_TYPES.has(existing.field_type) && input.options !== undefined) {
    // Removing an option would orphan stored values: keep every existing value (its label may change).
    const kept = new Set(opt.options.map((o) => o.value));
    const missing = existing.options.filter((o) => !kept.has(o.value));
    if (missing.length) errors.push(`Options already in use can be renamed but not removed: ${missing.map((o) => o.label).join(", ")}.`);
  }
  const options = SELECT_TYPES.has(field_type) ? opt.options : [];

  const group = input.group_name !== undefined ? str(input.group_name) : existing?.group_name ?? "";
  if (group.length > LIMITS.groupChars) errors.push(`The group name can be at most ${LIMITS.groupChars} characters.`);
  const description = input.description !== undefined ? str(input.description) : existing?.description ?? "";
  if (description.length > LIMITS.descriptionChars) errors.push(`The description can be at most ${LIMITS.descriptionChars} characters.`);
  const required = input.required !== undefined ? input.required === true || input.required === "true" : existing?.required ?? false;
  const orderRaw = input.sort_order !== undefined ? Number(input.sort_order) : existing?.sort_order ?? 0;
  const sort_order = Number.isFinite(orderRaw) ? Math.max(-1_000_000, Math.min(1_000_000, Math.round(orderRaw))) : 0;

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { label, name, field_type, options, required, group_name: group || null, description: description || null, sort_order } };
}

export type ValueResult = { ok: true; value: unknown } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on", "checked", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "unchecked"]);

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (iso) { y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]); }
  else if (us) { y = Number(us[3]); m = Number(us[1]); d = Number(us[2]); }
  else if (/^\d{12,14}$/.test(s)) { const t = new Date(Number(s)); if (Number.isNaN(t.getTime())) return null; return t.toISOString().slice(0, 10); } // HubSpot exports dates as epoch ms
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function matchOption(def: FieldDefinition, raw: unknown): string | null {
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  const hit = def.options.find((o) => o.value === s) ?? def.options.find((o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower);
  return hit ? hit.value : null;
}

/**
 * Validates one value for a field and returns what is stored. Empty -> { ok: true, value: null } (the key is removed).
 * Accepts the loose forms an import brings ("$1,200.50", "Yes", "3/14/2026", "Gold;Silver", option labels).
 */
export function validateValue(def: FieldDefinition, raw: unknown): ValueResult {
  if (isEmptyValue(raw)) return { ok: true, value: null };
  const label = def.label;
  switch (def.field_type) {
    case "text": case "long_text": {
      if (typeof raw === "object") return { ok: false, error: `${label}: enter text.` };
      const s = String(raw).trim();
      const max = def.field_type === "text" ? LIMITS.textChars : LIMITS.longTextChars;
      if (s.length > max) return { ok: false, error: `${label}: at most ${max} characters.` };
      if (def.field_type === "text" && /[\r\n]/.test(s)) return { ok: true, value: s.replace(/\s*[\r\n]+\s*/g, " ") };
      return { ok: true, value: s };
    }
    case "number": case "money": {
      const n = toNumber(raw);
      if (n === null) return { ok: false, error: `${label}: enter a number.` };
      if (Math.abs(n) > 1e15) return { ok: false, error: `${label}: that number is too large.` };
      return { ok: true, value: def.field_type === "money" ? Math.round(n * 100) / 100 : n };
    }
    case "date": {
      const d = toDate(raw);
      return d ? { ok: true, value: d } : { ok: false, error: `${label}: enter a date as YYYY-MM-DD.` };
    }
    case "checkbox": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: true };
      if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      return { ok: false, error: `${label}: choose yes or no.` };
    }
    case "single_select": {
      if (typeof raw === "object") return { ok: false, error: `${label}: pick one option.` };
      const v = matchOption(def, raw);
      return v ? { ok: true, value: v } : { ok: false, error: `${label}: "${String(raw).slice(0, 40)}" is not one of the options.` };
    }
    case "multi_select": {
      const parts = Array.isArray(raw) ? raw : String(raw).split(/[;|]/);
      const out: string[] = [];
      for (const p of parts) {
        if (isEmptyValue(p)) continue;
        const v = matchOption(def, p);
        if (!v) return { ok: false, error: `${label}: "${String(p).slice(0, 40)}" is not one of the options.` };
        if (!out.includes(v)) out.push(v);
      }
      return { ok: true, value: out.length ? out : null };
    }
    case "url": {
      let s = String(raw).trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
      if (s.length > LIMITS.urlChars) return { ok: false, error: `${label}: that address is too long.` };
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        if (!u.hostname.includes(".")) throw new Error("host");
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: `${label}: enter a web address such as https://example.com.` };
      }
    }
    case "email": {
      const s = String(raw).trim();
      return EMAIL_RE.test(s) && s.length <= 320 ? { ok: true, value: s.toLowerCase() } : { ok: false, error: `${label}: enter an email address.` };
    }
    case "phone": {
      const s = String(raw).trim();
      const digits = s.replace(/\D/g, "");
      if (!/^[+\d\s().\-x]+$/i.test(s) || digits.length < 7 || digits.length > 15) return { ok: false, error: `${label}: enter a phone number.` };
      return { ok: true, value: s };
    }
    default:
      return { ok: false, error: `${label}: unknown field type.` };
  }
}

export type ValuesCheck = {
  /** Keys to set (value) and keys to remove (null). Only fields that exist and are not archived. */
  changes: Record<string, unknown>;
  errors: Array<{ field: string; error: string }>;
};

/**
 * Validates a set of values against the definitions. Unknown or archived names are errors (so a typo never silently
 * drops data). requireAll: every required field must end up with a value (current merged with changes).
 */
export function validateValues(
  defs: FieldDefinition[], input: unknown, current: Record<string, unknown> = {}, opts: { requireAll?: boolean } = {},
): ValuesCheck {
  const changes: Record<string, unknown> = {};
  const errors: Array<{ field: string; error: string }> = [];
  if (input === undefined || input === null) return { changes, errors };
  if (typeof input !== "object" || Array.isArray(input)) return { changes, errors: [{ field: "", error: "Custom field values must be an object." }] };
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = byName.get(name);
    if (!def) { errors.push({ field: name, error: `There is no custom field called "${name}".` }); continue; }
    if (def.archived_at) { errors.push({ field: name, error: `${def.label} is archived and can't be changed.` }); continue; }
    const r = validateValue(def, raw);
    if (!r.ok) { errors.push({ field: name, error: r.error }); continue; }
    changes[name] = r.value;
  }
  if (opts.requireAll) {
    for (const def of defs) {
      if (!def.required || def.archived_at) continue;
      const after = name_in(changes, def.name) ? changes[def.name] : current[def.name];
      if (isEmptyValue(after) && !errors.some((e) => e.field === def.name)) errors.push({ field: def.name, error: `${def.label} is required.` });
    }
  }
  return { changes, errors };
}

function name_in(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** current with changes applied (null removes). */
export function mergeValues(current: Record<string, unknown> | null | undefined, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** A value as text for CSV export and list cells: option labels, "Yes"/"No", "a; b". */
export function displayValue(def: FieldDefinition, v: unknown): string {
  if (isEmptyValue(v)) return "";
  if (def.field_type === "checkbox") return v === true ? "Yes" : v === false ? "No" : String(v);
  const label = (x: unknown) => def.options.find((o) => o.value === x)?.label ?? String(x);
  if (def.field_type === "single_select") return label(v);
  if (def.field_type === "multi_select") return (Array.isArray(v) ? v : [v]).map(label).join("; ");
  return String(v);
}

// ---- list filters ------------------------------------------------------------------------------------------------
// Query parameters on the contact, company and pipeline lists:
//   cf_<name>=<value>          text types: contains (case-insensitive); single_select: one of (comma-separated values);
//                              multi_select: has any of; checkbox: true | false
//   cf_<name>_min / _max       number, money, date ranges (inclusive)
//   cf_<name>=__empty__ | __any__   no value / any value (every type)

export type FilterSql = { sql: string[]; params: unknown[] };

/** SQL conditions for the cf_* parameters in query, appended to params (positions continue from params.length). */
export function customFieldFilters(defs: FieldDefinition[], query: Record<string, unknown>, alias: string, params: unknown[]): string[] {
  const out: string[] = [];
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("bad alias");
  for (const def of defs) {
    const key = `cf_${def.name}`;
    const col = `${alias}.custom_fields`;
    // def.name matches NAME_RE (checked on create and by the table constraint), so it is safe inside a quoted literal.
    const v = query[key];
    const s = Array.isArray(v) ? String(v[0] ?? "") : v === undefined || v === null ? "" : String(v).trim();
    const has = `(${col} ? '${def.name}')`;
    if (s === "__empty__") { out.push(`NOT ${has}`); continue; }
    if (s === "__any__") { out.push(has); continue; }
    if (s) {
      switch (def.field_type) {
        case "single_select": {
          params.push(s.split(",").map((x) => x.trim()).filter(Boolean));
          out.push(`(${col}->>'${def.name}') = ANY($${params.length}::text[])`);
          break;
        }
        case "multi_select": {
          params.push(s.split(",").map((x) => x.trim()).filter(Boolean));
          out.push(`(${col}->'${def.name}') ?| $${params.length}::text[]`);
          break;
        }
        case "checkbox": {
          const t = TRUE_WORDS.has(s.toLowerCase());
          out.push(t ? `(${col}->'${def.name}') = 'true'::jsonb` : `COALESCE((${col}->'${def.name}') = 'true'::jsonb, false) = false`);
          break;
        }
        case "number": case "money": {
          const n = toNumber(s);
          if (n === null) { out.push("false"); break; }
          params.push(n);
          out.push(`(CASE WHEN jsonb_typeof(${col}->'${def.name}') = 'number' THEN (${col}->>'${def.name}')::numeric END) = $${params.length}`);
          break;
        }
        case "date": {
          const d = toDate(s);
          if (!d) { out.push("false"); break; }
          params.push(d);
          out.push(`(${col}->>'${def.name}') = $${params.length}`);
          break;
        }
        default: {
          params.push(`%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
          out.push(`(${col}->>'${def.name}') ILIKE $${params.length}`);
        }
      }
    }
    for (const [suffix, op] of [["_min", ">="], ["_max", "<="]] as const) {
      const r = query[`${key}${suffix}`];
      const rs = r === undefined || r === null ? "" : String(Array.isArray(r) ? r[0] : r).trim();
      if (!rs) continue;
      if (def.field_type === "number" || def.field_type === "money") {
        const n = toNumber(rs);
        if (n === null) { out.push("false"); continue; }
        params.push(n);
        out.push(`(CASE WHEN jsonb_typeof(${col}->'${def.name}') = 'number' THEN (${col}->>'${def.name}')::numeric END) ${op} $${params.length}`);
      } else if (def.field_type === "date") {
        const d = toDate(rs);
        if (!d) { out.push("false"); continue; }
        params.push(d);
        out.push(`(${col}->>'${def.name}') ${op} $${params.length}`);
      }
    }
  }
  return out;
}

/** ORDER BY expression for sort=cf_<name>, or null when the name is not a field. */
export function customFieldSortExpr(defs: FieldDefinition[], sortCol: string, alias: string): string | null {
  if (!sortCol.startsWith("cf_")) return null;
  const def = defs.find((d) => `cf_${d.name}` === sortCol);
  if (!def || !/^[a-z_][a-z0-9_]*$/i.test(alias)) return null;
  const col = `${alias}.custom_fields`;
  if (def.field_type === "number" || def.field_type === "money") {
    return `(CASE WHEN jsonb_typeof(${col}->'${def.name}') = 'number' THEN (${col}->>'${def.name}')::numeric END)`;
  }
  return `lower(${col}->>'${def.name}')`;
}
