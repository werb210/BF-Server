import { Router } from "express";
import { pool } from "../db";
import { listLenders } from "../repositories/lenders.repo";
import { listLenderProducts } from "../repositories/lenderProducts.repo";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { ROLES } from "../auth/roles";
import { type LenderProductRecord } from "../db/schema/lenderProducts";
import {
  createLender,
  getLenderByIdHandler,
  getLenderWithProducts,
  updateLender,
} from "../controllers/lenders.controller";
import sendPackageRouter from "./lenders/sendPackage";

type LenderRow = {
  id: string;
  name: string | null;
  country: string | null;
  status?: string | null;
  active?: boolean | null;
  primary_contact_name?: string | null;
  primary_contact_email?: string | null;
  primary_contact_phone?: string | null;
  submission_method: string | null;
  submission_email?: string | null;
  api_config?: unknown | null;
  submission_config?: unknown | null;
  website?: string | null;
  products: LenderProductRecord[] | null;
  silo?: string | null;
};

const DEFAULT_SILO = "default";

function resolveSilo(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_SILO;
}

function filterBySilo<T extends { silo?: string | null }>(records: T[], silo: string): T[] {
  return records.filter((record) => resolveSilo(record.silo) === silo);
}

function resolveLenderStatus(row: LenderRow): { status: string; active: boolean } {
  const status = typeof row.status === "string" ? row.status : null;
  const active =
    typeof row.active === "boolean"
      ? row.active
      : status
        ? status.toUpperCase() === "ACTIVE"
        : true;
  const resolvedStatus = active ? "ACTIVE" : "INACTIVE";
  return { status: resolvedStatus, active };
}

const router = Router();

router.use(sendPackageRouter);

if (process.env.NODE_ENV === "test") {
  router.get(
    "/__test-error",
    safeHandler(() => {
      throw new Error("lenders test error");
    })
  );
}

router.get(
  "/",
  requireAuth,
  requireCapability([CAPABILITIES.LENDERS_READ]),
  safeHandler(async (req, res) => {
    const lendersRows = await listLenders(pool);
    const products = await listLenderProducts();
    const productsByLender = new Map<string, LenderProductRecord[]>();
    products.forEach((product) => {
      const list = productsByLender.get(product.lender_id) ?? [];
      list.push(product);
      productsByLender.set(product.lender_id, list);
    });

    const normalized = lendersRows.map((l: LenderRow) => {
      const resolved = resolveLenderStatus(l);
      return {
        id: l.id,
        name: l.name ?? "—",
        status: resolved.status,
        active: resolved.active,
        country: l.country ?? null,
        primary_contact_name: l.primary_contact_name ?? null,
        primary_contact_email: l.primary_contact_email ?? null,
        primary_contact_phone: l.primary_contact_phone ?? null,
        submission_method: l.submission_method ?? null,
        submission_email: l.submission_email ?? null,
        api_config: l.api_config ?? null,
        submission_config: l.submission_config ?? null,
        website: l.website ?? null,
        products: productsByLender.get(l.id) ?? [],
      };
    });
    const normalizedById = new Map(normalized.map((l) => [l.id, l]));
    const user = req.user;
    if (user?.role === ROLES.LENDER) {
      const lenderId = user.lenderId;
      const scoped = lenderId
        ? normalized.filter((l) => l.id === lenderId)
        : [];
      res.status(200).json(scoped);
      return;
    }
    if (user?.role === ROLES.ADMIN || user?.role === ROLES.OPS) {
      res.status(200).json(normalized);
      return;
    }
    const resolvedSilo = resolveSilo(req.user?.silo);
    const filtered = filterBySilo(lendersRows, resolvedSilo)
      .map((row) => normalizedById.get(row.id))
      .filter((entry): entry is (typeof normalized)[number] => Boolean(entry));
    res.status(200).json(filtered.filter((entry) => entry.active));
  })
);

router.get(
  "/active",
  requireAuth,
  requireCapability([CAPABILITIES.LENDERS_READ]),
  safeHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        name,
        country,
        active,
        status,
        submission_method,
        submission_email,
        api_config,
        submission_config,
        primary_contact_name,
        primary_contact_email,
        primary_contact_phone,
        website,
        created_at,
        updated_at
      FROM lenders
      WHERE active = true
      ORDER BY name ASC
      `
    );
    res.status(200).json(rows);
  })
);

router.get(
  "/:id/products",
  requireAuth,
  requireCapability([CAPABILITIES.LENDERS_READ]),
  safeHandler(getLenderWithProducts)
);

router.get(
  "/:id",
  requireAuth,
  requireCapability([CAPABILITIES.LENDERS_READ]),
  safeHandler(getLenderByIdHandler)
);

router.post(
  "/",
  requireAuth,
  requireCapability([CAPABILITIES.OPS_MANAGE]),
  safeHandler(createLender)
);

router.patch(
  "/:id",
  requireAuth,
  requireCapability([CAPABILITIES.OPS_MANAGE]),
  safeHandler(updateLender)
);

export default router;
