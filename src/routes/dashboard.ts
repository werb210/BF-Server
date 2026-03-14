import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    ok: true,
  });
});

router.get("/pipeline", async (_req, res) => {
  const pipeline = [
    {
      name: "New",
      cards: [],
    },
    {
      name: "Review",
      cards: [],
    },
    {
      name: "Requires Docs",
      cards: [],
    },
    {
      name: "Sent to Lender",
      cards: [],
    },
    {
      name: "Approved",
      cards: [],
    },
    {
      name: "Declined",
      cards: [],
    },
  ];

  res.json(pipeline);
});

router.get("/actions", async (_req, res) => {
  res.json({ count: 0 });
});

router.get("/document-health", async (_req, res) => {
  res.json({
    missingStatements: 0,
    missingAR: 0,
    rejected: 0,
  });
});

router.get("/lender-activity", async (_req, res) => {
  res.json({
    recent: 0,
    awaiting: 0,
    declined: 0,
  });
});

router.get("/offers", async (_req, res) => {
  res.json({
    new: 0,
    accepted: 0,
    expiring: 0,
  });
});

router.get("/metrics", async (_req, res) => {
  res.json({
    pipeline: 0,
    actions: 0,
    documentHealth: 0,
    lenderActivity: 0,
    offers: 0,
  });
});

export default router;
