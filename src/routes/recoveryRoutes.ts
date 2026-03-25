import { Router } from "express";

const router = Router();

function ok(res: any, data: any = {}) {
  res.json({ ok: true, data });
}

/* AUTH */

router.post("/auth/otp/start", (_req: any, res: any) => ok(res));
router.post("/auth/otp/verify", (_req: any, res: any) => res.json({ ok: true, token: "dev" }));
router.get("/api/auth/me", (_req: any, res: any) => ok(res, { user: null }));
router.post("/api/auth/logout", (_req: any, res: any) => ok(res));

/* DASHBOARD */

router.get("/api/dashboard/metrics", (_req: any, res: any) => ok(res, { metrics: {} }));
router.get("/api/dashboard/pipeline", (_req: any, res: any) => ok(res, { pipeline: [] }));
router.get("/api/dashboard/offers", (_req: any, res: any) => ok(res, { offers: [] }));

/* APPLICATION */

router.get("/api/application/continuation", (_req: any, res: any) => ok(res, { step: 1 }));
router.post("/api/application", (_req: any, res: any) => ok(res, { id: "dev" }));
router.post("/api/application/update", (_req: any, res: any) => ok(res));

/* CRM */

router.get("/api/crm/leads", (_req: any, res: any) => ok(res, { leads: [] }));
router.post("/api/crm/web-leads", (_req: any, res: any) => ok(res));

/* SUPPORT */

router.post("/api/support/event", (_req: any, res: any) => ok(res));
router.get("/api/support/queue", (_req: any, res: any) => ok(res, { queue: [] }));

/* TELEPHONY */

router.get("/telephony/token", (_req: any, res: any) => res.json({ ok: true, token: "dev" }));
router.get("/api/telephony/presence", (_req: any, res: any) => ok(res, { online: [] }));

/* LENDERS */

router.get("/api/lenders", (_req: any, res: any) => ok(res, { lenders: [] }));
router.get("/api/lender-products", (_req: any, res: any) => ok(res, { products: [] }));

export default router;
