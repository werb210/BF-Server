import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { pool } from "../db.js";

const router = Router();
router.use(requireAuth);

router.get("/", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const rawSilo = getSilo(res);
  const silo = ["BF", "BI", "SLF"].includes(rawSilo) ? rawSilo : "BF";

  const { rows } = await pool.query(
    `SELECT c.*, count(ct.id)::int AS contact_count
     FROM companies c
     LEFT JOIN contacts ct ON ct.company_id = c.id
     WHERE c.silo = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [silo]
  );

  res.json({ ok: true, data: rows });
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const body = req.body ?? {};
  if (!body.name) throw new AppError("validation_error", "name is required", 400);
  const { rows } = await pool.query(
    `INSERT INTO companies
      (name, website, city, province, country, industry, annual_revenue, number_of_employees, silo, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      body.name,
      body.website ?? null,
      body.city ?? null,
      body.province ?? null,
      body.country ?? "Canada",
      body.industry ?? null,
      body.annual_revenue ?? null,
      body.number_of_employees ?? null,
      body.silo ?? "BF",
      body.owner_id ?? req.user?.userId ?? null,
    ]
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

router.get("/:id", safeHandler(async (req: any, res: any) => {
  const id = req.params.id;
  const companyRes = await pool.query(`SELECT * FROM companies WHERE id = $1 LIMIT 1`, [id]);
  const company = companyRes.rows[0];
  if (!company) throw new AppError("not_found", "Company not found", 404);

  const contactsRes = await pool.query(
    `SELECT id, name, email, phone, company_name, lead_status, owner_id, created_at
     FROM contacts
     WHERE company_id = $1
     ORDER BY created_at DESC`,
    [id]
  );

  const timelineRes = await pool.query(
    `SELECT event_type, description, created_at
     FROM crm_timeline_events
     WHERE company_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [id]
  ).catch(() => ({ rows: [] as any[] }));

  res.json({ ok: true, data: { ...company, contacts: contactsRes.rows, activity_timeline: timelineRes.rows } });
}));

router.patch("/:id", safeHandler(async (req: any, res: any) => {
  const id = req.params.id;
  const body = req.body ?? {};
  const fields: string[] = [];
  const values: unknown[] = [];

  const allowed = [
    "name",
    "website",
    "city",
    "province",
    "country",
    "industry",
    "annual_revenue",
    "number_of_employees",
    "silo",
    "owner_id",
  ] as const;

  for (const key of allowed) {
    if (body[key] !== undefined) {
      values.push(body[key]);
      fields.push(`${key} = $${values.length}`);
    }
  }
  if (fields.length === 0) {
    return res.json({ ok: true });
  }
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE companies SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) throw new AppError("not_found", "Company not found", 404);
  res.json({ ok: true, data: rows[0] });
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  await pool.query(`DELETE FROM companies WHERE id = $1`, [req.params.id]);
  res.status(204).end();
}));

export default router;
