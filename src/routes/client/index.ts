import { randomUUID } from "node:crypto";
import { Router } from "express";
import continuationRouter from "./continuation.js";
import documentsRouter from "./documents.js";
import applicationsRouter from "./applications.js";
import lendersRouter from "./lenders.js";
import lenderProductsRouter from "./lenderProducts.js";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes.js";
import sessionRouter from "./session.js";
import {
  clientDocumentsRateLimit,
  clientReadRateLimit,
} from "../../middleware/rateLimit.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { AppError } from "../../middleware/errors.js";

const router = Router();
const clientReadLimiter = clientReadRateLimit() as any;

router.use((req: any, res: any, next: any) => {
  if (req.method === "GET") {
    clientReadLimiter(req, res, next);
    return;
  }
  next();
});

router.use("/", continuationRouter);
router.use("/", applicationsRouter);
router.use("/lenders", lendersRouter);
router.use("/", lenderProductsRouter);
router.use("/", clientSubmissionRoutes);
router.use("/", sessionRouter);
router.use("/documents", clientDocumentsRateLimit(), documentsRouter);

router.get(
  "/readiness-prefill",
  safeHandler(async (req: any, res: any) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : null;
    const token = typeof req.query.token === "string" ? req.query.token.trim() : null;

    if (!phone && !token) {
      res.status(400).json({ error: "phone_or_token_required" });
      return;
    }

    let row: Record<string, any> | undefined;
    if (token) {
      const result = await dbQuery(
        `select * from readiness_sessions where id = $1 and is_active = true limit 1`,
        [token]
      );
      row = result.rows[0];
    } else {
      const result = await dbQuery(
        `select * from readiness_sessions where phone = $1 and is_active = true order by created_at desc limit 1`,
        [phone]
      );
      row = result.rows[0];
    }

    if (!row) {
      res.status(200).json({ found: false });
      return;
    }

    res.status(200).json({
      found: true,
      prefill: {
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        yearsInBusiness: row.years_in_business,
        annualRevenue: row.annual_revenue,
        profitable: typeof row.profitable === "boolean" ? row.profitable : null,
        existing_debt: typeof row.existing_debt === "boolean" ? row.existing_debt : null,
        companyName: row.company_name ?? null,
        score: row.score ?? null,
      },
    });
  })
);

router.get(
  "/messages",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    const rows = await dbQuery(
      `SELECT id, direction, body, staff_name, created_at
       FROM communications_messages
       WHERE application_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [applicationId]
    );

    res.status(200).json({
      status: "ok",
      data: (rows.rows ?? []).map((r: any) => ({
        id: r.id,
        role: r.direction === "outbound" ? "staff" : "client",
        content: r.body,
        staffName: r.staff_name ?? null,
        createdAt: r.created_at,
      })),
    });
  })
);

router.post(
  "/messages",
  // BF_SERVER_v64_CLIENT_MSG_ENRICH — populate contact_id + silo from
  // applications so messages from the mini-portal land in the staff
  // portal Communications view (which filters by contact_id + silo).
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : null;
    if (!applicationId || !body) {
      throw new AppError("validation_error", "applicationId and body are required.", 400);
    }

    const id = randomUUID();
    await dbQuery(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, created_at)
       VALUES (
         $1, 'message', 'inbound', 'received', $2,
         (SELECT contact_id FROM applications WHERE id = $2 LIMIT 1),
         COALESCE((SELECT silo FROM applications WHERE id = $2 LIMIT 1), 'BF'),
         $3, now()
       )`,
      [id, applicationId, body]
    );

    res.status(201).json({ status: "ok", data: { id } });
  })
);

export default router;
