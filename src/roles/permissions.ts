// BF_SERVER_v870_CRM_DATA_MODEL - the permission matrix behind custom roles (ported from KS-server #49, plan gate
// removed).
//
// A permission is an area plus an action: contacts.view, applications.delete, reports.export ... Every custom role is
// built FROM one of the built-in roles (its "base": Admin, Ops, Staff or Marketing). The base decides what the
// existing role checks let the person reach, and the role's matrix can only take things away from it:
//   - users.role stays the base role, so every existing role check, silo rule, notification to admins and the rest of
//     the server treat the person exactly as their base role;
//   - on top of that the matrix is enforced per request (src/roles/enforce.ts), from the route's area and method.
// A matrix can never grant more than its base allows (clampToBase), so a custom role is always a narrowing.
//
// Built-in roles are read-only templates: TEMPLATES below maps each one to the matrix the editor shows. People on a
// built-in role (users.custom_role_id NULL - every existing user) are never checked against a matrix at all, so their
// access is exactly what it was before custom roles existed (src/roles/__tests__ proves it, and proves a custom role
// copied from a template unchanged reaches every route its base role could).
//
// Record visibility (own / team / all) is part of a role too: built-in roles keep the per-role setting on Settings >
// Teams (role_record_visibility); a custom role carries its own, and a per-person override still wins.

export const AREAS = [
  "contacts",
  "companies",
  "applications",
  "lenders",
  "documents",
  "communications",
  "calls",
  "marketing",
  "reports",
  "settings",
  "billing",
  "users",
] as const;
export type Area = (typeof AREAS)[number];

export const ACTIONS = ["view", "create", "edit", "delete", "export"] as const;
export type Action = (typeof ACTIONS)[number];

export type PermissionSet = Record<Area, Record<Action, boolean>>;

export const BASE_ROLES = ["Admin", "Ops", "Staff", "Marketing"] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

export const AREA_LABELS: Record<Area, string> = {
  contacts: "Contacts",
  companies: "Companies",
  applications: "Applications and deals",
  lenders: "Lenders and products",
  documents: "Documents",
  communications: "Email, texts and inbox",
  calls: "Calls and recordings",
  marketing: "Marketing",
  reports: "Reports",
  settings: "Settings",
  billing: "QuickBooks and fee invoices",
  users: "Users, teams and roles",
};

export const ACTION_LABELS: Record<Action, string> = { view: "View", create: "Create", edit: "Edit", delete: "Delete", export: "Export" };

export function isArea(v: unknown): v is Area {
  return typeof v === "string" && (AREAS as readonly string[]).includes(v);
}
export function isAction(v: unknown): v is Action {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}
export function isBaseRole(v: unknown): v is BaseRole {
  return typeof v === "string" && (BASE_ROLES as readonly string[]).includes(v);
}

function fill(value: boolean): Record<Action, boolean> {
  return { view: value, create: value, edit: value, delete: value, export: value };
}
function only(...actions: Action[]): Record<Action, boolean> {
  const r = fill(false);
  for (const a of actions) r[a] = true;
  return r;
}

export function emptyPermissions(): PermissionSet {
  return Object.fromEntries(AREAS.map((a) => [a, fill(false)])) as PermissionSet;
}
export function fullPermissions(): PermissionSet {
  return Object.fromEntries(AREAS.map((a) => [a, fill(true)])) as PermissionSet;
}

// The work every staff role does. A template must cover everything the built-in role can already reach (the route's
// own role checks still keep Admin-only screens Admin-only), so Staff and Marketing keep: their own report layouts
// (reports.edit), Maya's voice and their own settings (settings.edit), retrying a client's fee invoice
// (billing.edit). Users, teams and roles are Admin screens.
const STAFF_TEMPLATE = (): PermissionSet => ({
  contacts: fill(true),
  companies: fill(true),
  applications: fill(true),
  lenders: fill(true),
  documents: fill(true),
  communications: fill(true),
  calls: fill(true),
  marketing: fill(true),
  reports: only("view", "edit", "export"),
  settings: only("view", "edit"),
  billing: only("view", "edit"),
  users: fill(false),
});

/** The read-only templates: what each built-in role can do, as a matrix. */
export const TEMPLATES: Record<BaseRole, () => PermissionSet> = {
  Admin: fullPermissions,
  // Ops manages users (user:manage) and every CRM area; Admin-only screens stay Admin-only by their own role checks.
  Ops: fullPermissions,
  Staff: STAFF_TEMPLATE,
  // A Marketing user has the Staff user's access (the Marketing-only tools are checked separately).
  Marketing: STAFF_TEMPLATE,
};

export function templateFor(base: BaseRole): PermissionSet {
  return TEMPLATES[base]();
}

/** Any input -> a complete matrix (unknown areas/actions dropped, missing ones false). */
export function normalizePermissions(raw: unknown): PermissionSet {
  const out = emptyPermissions();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [area, actions] of Object.entries(raw as Record<string, unknown>)) {
    if (!isArea(area)) continue;
    if (Array.isArray(actions)) {
      for (const a of actions) if (isAction(a)) out[area][a] = true;
      continue;
    }
    if (!actions || typeof actions !== "object") continue;
    for (const [action, on] of Object.entries(actions as Record<string, unknown>)) {
      if (isAction(action)) out[area][action] = on === true;
    }
  }
  // Doing anything in an area needs seeing it.
  for (const area of AREAS) {
    if (!out[area].view && ACTIONS.some((a) => a !== "view" && out[area][a])) out[area].view = true;
  }
  return out;
}

/** The matrix limited to what the base role itself may do. */
export function clampToBase(p: PermissionSet, base: BaseRole): PermissionSet {
  const t = templateFor(base);
  const out = emptyPermissions();
  for (const area of AREAS) for (const a of ACTIONS) out[area][a] = Boolean(p[area]?.[a]) && t[area][a];
  return out;
}

/** Permissions the matrix grants that the base role does not (shown to the admin, then dropped). */
export function beyondBase(p: PermissionSet, base: BaseRole): string[] {
  const t = templateFor(base);
  const out: string[] = [];
  for (const area of AREAS) for (const a of ACTIONS) if (p[area]?.[a] && !t[area][a]) out.push(`${area}.${a}`);
  return out;
}

export function allows(p: PermissionSet, area: Area, action: Action): boolean {
  return Boolean(p[area]?.[action]);
}

/** "contacts.view" style list (for the portal and the audit log). */
export function permissionList(p: PermissionSet): string[] {
  const out: string[] = [];
  for (const area of AREAS) for (const a of ACTIONS) if (p[area][a]) out.push(`${area}.${a}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Which permission a request needs. Paths are relative to /api.

/** Personal and app-shell endpoints every signed-in staff member keeps, whatever their role (own profile, own
 *  sessions, field definitions, branding ...). Checked before the area rules. */
const ALWAYS_ALLOWED: ReadonlyArray<{ methods?: RegExp; path: RegExp }> = [
  { path: /^\/users\/me(\/|$)/ },
  { path: /^\/roles\/me$/ },
  { path: /^\/settings\/(me|preferences)(\/|$)/ },
  { methods: /^(GET|HEAD)$/, path: /^\/settings(\/branding)?\/?$/ },
  { path: /^\/teams\/(me|options)$/ },
  { path: /^\/security\/(status|me)(\/|$)/ },
  { path: /^\/booking-settings\/my-link$/ },
  { path: /^\/lead-rotation\/me$/ },
  { path: /^\/task-defaults(\/|$)/ },
  { methods: /^(GET|HEAD)$/, path: /^\/custom-fields(\/[^/]+)?\/?$/ },
  { path: /^\/call-queues\/me$/ }, // BF_SERVER_v871_CALL_QUEUES - my own "available for queue calls" switch
  { methods: /^(GET|HEAD)$/, path: /^\/call-scripts\/?$/ }, // BF_SERVER_v871_CALL_SCRIPTS - the scripts to choose from
  { methods: /^(GET|HEAD)$/, path: /^\/retention\/(status|applications\/[^/]+)$/ },
  { methods: /^(GET|HEAD|POST)$/, path: /^\/privacy\/(consent|region)$/ },
];

/** Area by path prefix, first match wins (so the more specific prefixes come first). */
const AREA_RULES: ReadonlyArray<[RegExp, Area]> = [
  // Custom field VALUES on a record are part of editing that record.
  [/^\/custom-fields\/contacts?\/records\//, "contacts"],
  [/^\/custom-fields\/compan(y|ies)\/records\//, "companies"],
  [/^\/custom-fields\/(applications?|deals?)\/records\//, "applications"],
  [/^\/crm\/inbox(\/|$)/, "communications"],
  [/^\/crm\/(companies|unified\/compan|unified\/(duplicates|ai-summary)\/compan)/, "companies"],
  [/^\/companies(\/|$)/, "companies"],
  [/^\/crm\/(calls?|voicemails?)(\/|$)/, "calls"],
  [/^\/crm(\/|$)/, "contacts"],
  [/^\/portal\/documents(\/|$)/, "documents"],
  [/^\/documents(\/|$)/, "documents"],
  [/^\/portal\/(lenders|lender-products)(\/|$)/, "lenders"],
  [/^\/(lenders|lender-products|lender-qa)(\/|$)/, "lenders"],
  [/^\/portal\/applications(\/|$)/, "applications"],
  [/^\/(applications|pipeline|offers|collateral|application-origin|banking|lender-referrals|broker-imports|pgi|fraud)(\/|$)/, "applications"],
  [/^\/credit(-summary(-v2)?|-research|-collateral|-financials)?(\/|$)/, "applications"],
  [/^\/(communications|messages|conversations|email|templates)(\/|$)/, "communications"],
  [/^\/o365\/mail(\/|$)/, "communications"],
  [/^\/(calls|voice|telephony)(\/|$)/, "calls"],
  [/^\/call-scripts\/runs(\/|$)/, "calls"], // BF_SERVER_v871_CALL_SCRIPTS - filling in a script is part of the call
  [/^\/call-queues\/callbacks(\/|$)/, "calls"], // BF_SERVER_v871_CALL_QUEUES
  [/^\/(call-scripts|call-queues)(\/|$)/, "settings"], // BF_SERVER_v871_CALLING_TOOLS - Admin set-up
  [/^\/(marketing|automations)(\/|$)/, "marketing"], // automations (workflows) are a Marketing-role tool
  [/^\/(reporting|reports)(\/|$)/, "reports"],
  // A client's fee invoice on a file is application work; the QuickBooks connection itself is billing.
  [/^\/quickbooks\/applications(\/|$)/, "applications"],
  [/^\/pipelines(\/|$)/, "applications"],
  [/^\/quickbooks(\/|$)/, "billing"],
  [/^\/(users|teams|roles)(\/|$)/, "users"],
  [/^\/admin\/users(\/|$)/, "users"],
  [/^\/(export|admin\/exports|data-import)(\/|$)/, "settings"],
  [/^\/(settings|licensee|phone-menu|phone-numbers|booking-settings|privacy|security|never-log|lead-rotation|blocked-numbers|surveys|custom-fields|retention|task-defaults)(\/|$)/, "settings"],
];

const EXPORT_PATH = /(^|\/)(exports?|download-all)(\/|\.|$)|\.(csv|xlsx)$/i;
const READ_POST = /\/(search|query|preview|lookup|suggest|dedupe-preview|count|filter)$/i;
const DELETE_POST = /\/(bulk-delete|purge[^/]*|delete)$/i;
const EDIT_POST = /\/(bulk-tag|bulk-assign|bulk-update|merge|dedupe-merge|assign|archive|unarchive|restore|move|stage|status|reorder|order)$/i;

export type RequiredPermission = { area: Area; action: Action };

/** The permission a request needs, or null when it is not in any area (or always allowed). `path` is under /api. */
export function requiredPermission(method: string, path: string): RequiredPermission | null {
  const m = String(method || "GET").toUpperCase();
  const p = ("/" + String(path || "").replace(/^\/+/, "")).replace(/\?.*$/, "");
  if (m === "OPTIONS") return null;
  if (ALWAYS_ALLOWED.some((r) => r.path.test(p) && (!r.methods || r.methods.test(m)))) return null;
  const rule = AREA_RULES.find(([re]) => re.test(p));
  if (!rule) return null;
  const area = rule[1];
  let action: Action;
  if (EXPORT_PATH.test(p)) action = "export";
  else if (m === "GET" || m === "HEAD") action = "view";
  else if (m === "DELETE") action = "delete";
  else if (m === "PUT" || m === "PATCH") action = "edit";
  else if (READ_POST.test(p)) action = "view";
  else if (DELETE_POST.test(p)) action = "delete";
  else if (EDIT_POST.test(p)) action = "edit";
  else action = "create";
  // Settings, billing and users screens are edited in place: their POSTs change settings rather than create records.
  if ((area === "settings" || area === "billing") && action === "create") action = "edit";
  return { area, action };
}

/** Plain-words refusal for a missing permission. */
export function deniedMessage(req: RequiredPermission): string {
  const what = AREA_LABELS[req.area].toLowerCase();
  const verb = req.action === "view" ? "see" : req.action === "export" ? "export" : req.action;
  return `Your role does not let you ${verb} ${what}. Ask an Admin if you need this.`;
}
