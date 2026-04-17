/**
 * Missing portal lender CRUD routes (GET /:id, POST, PATCH /:id, DELETE /:id).
 * The GET / list route already lives in portal.ts — this file adds the rest.
 * Mounted at /api/portal by routeRegistry.
 */
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import {
  fetchLenderById,
  createLender,
  updateLender,
} from "../repositories/lenders.repo.js";

const router = Router();

// GET /api/portal/lenders/:id
router.get(
  "/lenders/:id",
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    const lender = await fetchLenderById(id);
    if (!lender) throw new AppError("not_found", "Lender not found.", 404);
    res.status(200).json(lender);
  })
);

// POST /api/portal/lenders
router.post(
  "/lenders",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const body = req.body ?? {};
    if (!body.name || !body.country)
      throw new AppError("validation_error", "name and country are required.", 400);

    const lender = await createLender(pool, {
      name: body.name,
      country: body.country,
      submission_method: body.submissionMethod ?? body.submission_method ?? "EMAIL",
      active: body.active ?? true,
      status: body.status ?? "ACTIVE",
      email: body.email ?? null,
      primary_contact_name: body.primaryContactName ?? body.primary_contact_name ?? null,
      primary_contact_email: body.primaryContactEmail ?? body.primary_contact_email ?? null,
      primary_contact_phone: body.primaryContactPhone ?? body.primary_contact_phone ?? null,
      submission_email: body.submissionEmail ?? body.submission_email ?? null,
      api_config: body.apiConfig ?? body.api_config ?? null,
      submission_config: body.submissionConfig ?? body.submission_config ?? null,
      website: body.website ?? null,
      street: body.street ?? body.address?.street ?? null,
      city: body.city ?? body.address?.city ?? null,
      region: body.region ?? body.address?.stateProvince ?? null,
      postal_code: body.postalCode ?? body.postal_code ?? body.address?.postalCode ?? null,
      phone: body.phone ?? null,
    });
    res.status(201).json(lender);
  })
);

// PATCH /api/portal/lenders/:id
router.patch(
  "/lenders/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    const body = req.body ?? {};
    const lender = await updateLender(pool, {
      id,
      name: body.name,
      status: body.status,
      country: body.country,
      email: body.email,
      submission_method: body.submissionMethod ?? body.submission_method,
      primary_contact_name: body.primaryContactName ?? body.primary_contact_name,
      primary_contact_email: body.primaryContactEmail ?? body.primary_contact_email,
      primary_contact_phone: body.primaryContactPhone ?? body.primary_contact_phone,
      submission_email: body.submissionEmail ?? body.submission_email,
      api_config: body.apiConfig ?? body.api_config,
      submission_config: body.submissionConfig ?? body.submission_config,
      website: body.website,
      active: body.active,
    });
    if (!lender) throw new AppError("not_found", "Lender not found.", 404);
    res.status(200).json(lender);
  })
);

// DELETE /api/portal/lenders/:id
router.delete(
  "/lenders/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    await runQuery("DELETE FROM lenders WHERE id = $1", [id]);
    res.status(204).end();
  })
);

export default router;
