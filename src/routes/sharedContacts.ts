// BF_SERVER_SHARED_CONTACTS_v1 (2026-11-24) - /api/directory: the shared list of brokers, lenders and banks.
//   POST /api/directory/import   { list_name, kind: broker|lender|bank, only?: ["BF","BI","KS"], companies?: [...], contacts?: [...] }
//        Loads a list once and fills each silo from it (see services/directory/sharedContacts.ts). Never emails anyone.
//   GET  /api/directory/people?kind=&country=&brand=&status=&q=&limit=&offset=
//   GET  /api/directory/imports   the last 50 list loads and what each did
//   POST /api/directory/sync      read every silo (BI CRM, Keystone prospects) into the list now (BF_SHARED_CONTACTS_STAGE2_v1)
// Staff (Admin or Staff) only.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { importSharedList, listPeople, KINDS, type Brand, type Kind } from "../services/directory/sharedContacts.js";
import { syncFromSilos } from "../services/directory/siloSync.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
export const SHARED_IMPORT_MAX = 5000;

router.post("/import", ...staff, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const listName = String(b.list_name ?? "").trim();
  const kind = String(b.kind ?? "").trim().toLowerCase();
  const companies = Array.isArray(b.companies) ? b.companies : [];
  const contacts = Array.isArray(b.contacts) ? b.contacts : [];
  if (!listName) return res.status(400).json({ error: "list_name_required", message: "Name the list, for example \"US lender search 3\"." });
  if (!(KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: "kind_required", message: "Say whether the list is brokers, lenders or banks." });
  if (!companies.length && !contacts.length) return res.status(400).json({ error: "empty_list", message: "The list has no companies or people." });
  if (companies.length + contacts.length > SHARED_IMPORT_MAX) return res.status(400).json({ error: "too_many", message: `At most ${SHARED_IMPORT_MAX} rows a call.` });
  const only = Array.isArray(b.only) ? (b.only.filter((x: unknown) => ["BF", "BI", "KS"].includes(String(x))) as Brand[]) : null;
  const auth = String(req.headers?.authorization ?? "");
  const result = await importSharedList(pool, {
    fetch: (url, init) => fetch(url, init) as any,
    biUrl: process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net",
    ksOpsUrl: process.env.KS_OPS_URL || "https://ops.keystonecrm.online",
    staffToken: auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null,
  }, { list_name: listName, kind: kind as Kind, only, companies, contacts, created_by: req.user?.id ? String(req.user.id) : null });
  res.status(201).json(result);
}));

router.get("/people", ...staff, safeHandler(async (req: any, res: any) => {
  const q = req.query ?? {};
  res.json(await listPeople(pool, {
    kind: q.kind ? String(q.kind) : undefined, country: q.country ? String(q.country) : undefined, brand: q.brand ? String(q.brand) : undefined,
    status: q.status ? String(q.status) : undefined, q: q.q ? String(q.q) : undefined, limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined,
  }));
}));

router.post("/sync", ...staff, safeHandler(async (req: any, res: any) => {
  const auth = String(req.headers?.authorization ?? "");
  const result = await syncFromSilos(pool, {
    fetch: (url, init) => fetch(url, init) as any,
    biUrl: process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net",
    ksOpsUrl: process.env.KS_OPS_URL || "https://ops.keystonecrm.online",
    staffToken: auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null,
  }, req.user?.id ? String(req.user.id) : "staff");
  res.json(result);
}));

router.get("/imports", ...staff, safeHandler(async (_req: any, res: any) => {
  const r = await pool.query(`SELECT id, list_name, kind, row_count, routing, result, created_by, created_at FROM directory_imports ORDER BY created_at DESC LIMIT 50`);
  res.json({ imports: r.rows });
}));

export default router;
