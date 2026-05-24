import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { getSilo } from "../middleware/silo.js";

const router = Router();
router.use(requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }));

const ids = (v: any) => Array.isArray(v) ? v.map(String).filter(Boolean) : [];

router.post('/contacts/bulk-delete', async (req, res) => {
  const selected = ids(req.body?.ids); const silo = getSilo(res);
  const protectedRes = await pool.query(`SELECT c.id FROM contacts c JOIN lenders l ON l.owner_contact_id = c.id WHERE c.id = ANY($1::uuid[]) AND c.silo = $2`, [selected, silo]);
  const protectedIds = protectedRes.rows.map((r:any)=>r.id);
  if (protectedIds.length) return res.status(409).json({ error: 'fk_protected', protectedIds });
  const out = await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[]) AND silo = $2`, [selected, silo]);
  res.json({ deleted: out.rowCount ?? 0, protectedIds: [] });
});

router.post('/contacts/bulk-tag', async (req, res) => {
  const selected = ids(req.body?.ids); const tags = ids(req.body?.tags); const op = String(req.body?.op ?? 'add'); const silo = getSilo(res);
  let sql = `UPDATE contacts SET tags = $2::text[] WHERE id = ANY($1::uuid[]) AND silo = $3`;
  let params:any[] = [selected, tags, silo];
  if (op === 'add') { sql = `UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(coalesce(contacts.tags,'{}'::text[]) || $2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`; }
  if (op === 'remove') { sql = `UPDATE contacts SET tags = ARRAY(SELECT t FROM unnest(coalesce(tags,'{}'::text[])) t WHERE NOT (t = ANY($2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`; }
  const out = await pool.query(sql, params); res.json({ updated: out.rowCount ?? 0 });
});

router.post('/contacts/bulk-assign', async (req, res) => {
  const selected = ids(req.body?.ids); const ownerUserId = String(req.body?.ownerUserId ?? ''); const silo = getSilo(res);
  const u = await pool.query(`SELECT id FROM users WHERE id::text = ($1)::text LIMIT 1`, [ownerUserId]); if (!u.rows[0]) return res.status(400).json({ error: 'invalid_owner' });
  const out = await pool.query(`UPDATE contacts SET owner_id = $2 WHERE id = ANY($1::uuid[]) AND silo = $3`, [selected, ownerUserId, silo]); res.json({ updated: out.rowCount ?? 0 });
});

router.post('/companies/bulk-delete', async (req, res) => {
  const selected = ids(req.body?.ids); const silo = getSilo(res);
  const prot = await pool.query(`SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2 AND (EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = companies.id) OR EXISTS (SELECT 1 FROM applications a WHERE a.company_id = companies.id))`, [selected, silo]);
  const protectedIds = prot.rows.map((r:any)=>r.id); if (protectedIds.length) return res.status(409).json({ error:'fk_protected', protectedIds });
  const out = await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2`, [selected, silo]); res.json({ deleted: out.rowCount ?? 0, protectedIds: [] });
});

router.post('/companies/bulk-tag', async (req, res) => {
  const selected = ids(req.body?.ids); const tags = ids(req.body?.tags); const op = String(req.body?.op ?? 'add'); const silo = getSilo(res);
  let sql = `UPDATE companies SET tags = $2::text[] WHERE id = ANY($1::uuid[]) AND silo = $3`;
  if (op === 'add') sql = `UPDATE companies SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(coalesce(companies.tags,'{}'::text[]) || $2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`;
  if (op === 'remove') sql = `UPDATE companies SET tags = ARRAY(SELECT t FROM unnest(coalesce(tags,'{}'::text[])) t WHERE NOT (t = ANY($2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`;
  const out = await pool.query(sql, [selected, tags, silo]); res.json({ updated: out.rowCount ?? 0 });
});

router.post('/companies/bulk-assign', async (req, res) => {
  const selected = ids(req.body?.ids); const ownerUserId = String(req.body?.ownerUserId ?? ''); const silo = getSilo(res);
  const u = await pool.query(`SELECT id FROM users WHERE id::text = ($1)::text LIMIT 1`, [ownerUserId]); if (!u.rows[0]) return res.status(400).json({ error: 'invalid_owner' });
  const out = await pool.query(`UPDATE companies SET owner_id = $2 WHERE id = ANY($1::uuid[]) AND silo = $3`, [selected, ownerUserId, silo]); res.json({ updated: out.rowCount ?? 0 });
});

export default router;
