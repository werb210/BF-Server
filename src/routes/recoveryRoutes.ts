import { Router } from "express";

const router = Router();

function ok(res: any, data: any = {}) {
  res.json({ ok: true, data });
}

/* AUTH */

router.post("/api/auth/otp/start", (_req, res) => ok(res));
router.post("/api/auth/otp/verify", (_req, res) => ok(res, { token: "dev" }));
router.get("/api/auth/me", (_req, res) => ok(res, { user: null }));
router.post("/api/auth/logout", (_req, res) => ok(res));

/* DASHBOARD */

router.get("/api/dashboard/metrics", (_req, res) => ok(res, { metrics: {} }));
router.get("/api/dashboard/pipeline", (_req, res) => ok(res, { pipeline: [] }));
router.get("/api/dashboard/offers", (_req, res) => ok(res, { offers: [] }));

/* APPLICATION */

router.get("/api/application/continuation", (_req, res) => ok(res, { step: 1 }));
router.post("/api/application", (_req, res) => ok(res, { id: "dev" }));
router.post("/api/application/update", (_req, res) => ok(res));

/* CRM */

router.get("/api/crm/leads", (_req, res) => ok(res, { leads: [] }));
router.post("/api/crm/web-leads", (_req, res) => ok(res));

/* SUPPORT */

router.post("/api/support/event", (_req, res) => ok(res));
router.get("/api/support/queue", (_req, res) => ok(res, { queue: [] }));

/* TELEPHONY */

router.get("/api/telephony/token", (_req, res) => ok(res, { token: "dev" }));
router.get("/api/telephony/presence", (_req, res) => ok(res, { online: [] }));

/* LENDERS */

router.get("/api/lenders", (_req, res) => ok(res, { lenders: [] }));
router.get("/api/lender-products", (_req, res) => ok(res, { products: [] }));

export default router;
