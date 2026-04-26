import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { pool } from "../db.js";
import { getSilo } from "../middleware/silo.js";

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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const startDate = body.start_date;
  const employeeCount = body.employee_count;
  const annualRevenue = body.estimated_annual_revenue;
  if (!name) return res.status(400).json({ error: { field: "name", message: "name is required" } });
  if (startDate !== undefined && startDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    return res.status(400).json({ error: { field: "start_date", message: "start_date must be yyyy-mm-dd" } });
  }
  if (employeeCount !== undefined && employeeCount !== null && !Number.isInteger(Number(employeeCount))) {
    return res.status(400).json({ error: { field: "employee_count", message: "employee_count must be an integer" } });
  }
  if (annualRevenue !== undefined && annualRevenue !== null && Number.isNaN(Number(annualRevenue))) {
    return res.status(400).json({ error: { field: "estimated_annual_revenue", message: "estimated_annual_revenue must be numeric" } });
  }
  const silo = getSilo(res);
  const ownerId = req.user?.id ?? req.user?.userId ?? null;
  const id = crypto.randomUUID();
  try {
    const { rows } = await pool.query(
      `INSERT INTO companies
       (id, name, dba_name, legal_name, business_structure, address_street, address_city, address_state,
        address_zip, address_country, phone, email, website, start_date, employee_count,
        estimated_annual_revenue, silo, owner_id, status)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        id,
        name,
        body.dba_name ?? null,
        body.legal_name ?? null,
        body.business_structure ?? null,
        body.address_street ?? null,
        body.address_city ?? null,
        body.address_state ?? null,
        body.address_zip ?? null,
        body.address_country ?? null,
        body.phone ?? null,
        body.email ?? null,
        body.website ?? null,
        startDate ?? null,
        employeeCount != null ? Number(employeeCount) : null,
        annualRevenue != null ? Number(annualRevenue) : null,
        silo,
        ownerId,
        body.status ?? "prospect",
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err: any) {
    console.error({ event: "company_create_failed", err: String(err), code: err?.code });
    res.status(500).json({ error: { message: "failed_to_create_company", code: err?.code ?? "db_error" } });
  }
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
