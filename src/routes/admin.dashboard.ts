// BF_SERVER_BLOCK_BI_ROUND7_OPS_DASHBOARD_v1
// Operations dashboard endpoints. Powers the staff admin
// /admin/operations page (Operations.tsx). Sub-mounted under
// /api/admin so the routes resolve as:
//   GET   /api/admin/contacts
//   GET   /api/admin/issues
//   GET   /api/admin/chats
//   PATCH /api/admin/issues/:id
// Silo-gated via Block 13's resolveSiloFromRequest with an
// admin override (?silo=BF|BI|SLF) for cross-silo dashboards.

import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = Router();

// Helper: resolve effective silo with admin override
function effectiveSilo(req: any): string {
  const isAdmin = String(req.user?.role ?? "").toLowerCase() === "admin";
  const requested = typeof req.query.silo === "string"
    ? req.query.silo.toUpperCase()
    : null;
  if (isAdmin && requested && /^(BF|BI|SLF)$/.test(requested)) {
    return requested;
  }
  return resolveSiloFromRequest(req);
}

// Status enum normalization for the issues table. DB constraint
// enforces lowercase {open, in_progress, resolved}; the portal
// works in uppercase with CLOSED as the terminal alias.
const ISSUE_STATUS_TO_DB: Record<string, string> = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  CLOSED: "resolved",
};
const ISSUE_STATUS_TO_API: Record<string, string> = {
  open: "OPEN",
  in_progress: "IN_PROGRESS",
  resolved: "CLOSED",
};

router.get("/contacts", safeHandler(async (req: any, res: any) => {
  const silo = effectiveSilo(req);
  const result = await pool.query(`
    SELECT id, company_name, first_name, last_name, email, phone, created_at
    FROM contacts
    WHERE silo = $1
    ORDER BY created_at DESC NULLS LAST
    LIMIT 100
  `, [silo]).catch((err: any) => {
    console.warn("admin.dashboard.contacts.query_failed", {
      silo, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });
  const contacts = result.rows.map((r: any) => ({
    id: r.id,
    company: r.company_name ?? "",
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    email: r.email ?? "",
    phone: r.phone ?? "",
    createdAt: r.created_at,
  }));
  return res.status(200).json(contacts);
}));

router.get("/issues", safeHandler(async (req: any, res: any) => {
  const silo = effectiveSilo(req);
  const result = await pool.query(`
    SELECT
      i.id,
      i.title,
      i.description,
      i.screenshot_url,
      i.status,
      i.created_at,
      c.silo AS contact_silo
    FROM issues i
    LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE (c.silo IS NULL OR c.silo = $1)
    ORDER BY i.created_at DESC
    LIMIT 200
  `, [silo]).catch((err: any) => {
    console.warn("admin.dashboard.issues.query_failed", {
      silo, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });
  const issues = result.rows.map((r: any) => ({
    id: r.id,
    message: r.title || r.description || "",
    status: ISSUE_STATUS_TO_API[r.status] ?? "OPEN",
    createdAt: r.created_at,
  }));
  return res.status(200).json(issues);
}));

router.patch("/issues/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_id" });
  const rawStatus = String(req.body?.status ?? "").toUpperCase();
  const dbStatus = ISSUE_STATUS_TO_DB[rawStatus];
  if (!dbStatus) {
    return res.status(400).json({
      error: "invalid_status",
      received: rawStatus,
      allowed: Object.keys(ISSUE_STATUS_TO_DB),
    });
  }
  const result = await pool.query(`
    UPDATE issues
    SET status = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING id, status, updated_at
  `, [dbStatus, id]).catch((err: any) => {
    console.warn("admin.dashboard.issues.patch_failed", {
      id, dbStatus, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });
  if (!result.rows.length) {
    return res.status(404).json({ error: "issue_not_found" });
  }
  const row = result.rows[0];
  return res.status(200).json({
    id: row.id,
    status: ISSUE_STATUS_TO_API[row.status] ?? "OPEN",
    updatedAt: row.updated_at,
  });
}));

router.get("/chats", safeHandler(async (req: any, res: any) => {
  const silo = effectiveSilo(req);
  const result = await pool.query(`
    SELECT
      s.id,
      s.status,
      s.created_at,
      c.first_name,
      c.last_name,
      c.email,
      c.silo AS contact_silo,
      (
        SELECT STRING_AGG(role || ': ' || content, E'\\n' ORDER BY created_at ASC)
        FROM chat_messages m
        WHERE m.session_id = s.id
      ) AS transcript
    FROM chat_sessions s
    LEFT JOIN contacts c ON c.id = s.crm_contact_id
    WHERE s.status IN ('live', 'closed')
      AND (c.silo IS NULL OR c.silo = $1)
    ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
    LIMIT 100
  `, [silo]).catch((err: any) => {
    console.warn("admin.dashboard.chats.query_failed", {
      silo, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });
  const chats = result.rows.map((r: any) => {
    const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    return {
      id: r.id,
      name: fullName || "Unknown",
      email: r.email ?? "",
      transcript: r.transcript ?? "",
      status: r.status,
      createdAt: r.created_at,
    };
  });
  return res.status(200).json(chats);
}));

export default router;
