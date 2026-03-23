import { Router } from "express";

const router = Router();

/*
Temporary pipeline data so Portal UI can render cards.
This will be replaced by database queries later.
*/
const mockApplications = [
  {
    id: "app-1",
    company: "Demo Construction Ltd",
    amount: "$250,000",
    stage: "New",
  },
  {
    id: "app-2",
    company: "Northern Transport Inc",
    amount: "$500,000",
    stage: "Review",
  },
];

router.get("/", (_req: any, res: any) => {
  res.json({
    ok: true,
  });
});

router.get("/pipeline", async (_req: any, res: any) => {
  const stages = [
    "New",
    "Review",
    "Requires Docs",
    "Sent to Lender",
    "Approved",
    "Declined",
  ];

  const pipeline = stages.map((stage) => ({
    name: stage,
    cards: mockApplications.filter((application) => application.stage === stage),
  }));

  res.json(pipeline);
});

router.get("/actions", async (_req: any, res: any) => {
  res.json({ count: 0 });
});

router.get("/document-health", async (_req: any, res: any) => {
  res.json({
    missingStatements: 0,
    missingAR: 0,
    rejected: 0,
  });
});

router.get("/lender-activity", async (_req: any, res: any) => {
  res.json({
    recent: 0,
    awaiting: 0,
    declined: 0,
  });
});

router.get("/offers", async (_req: any, res: any) => {
  res.json({
    new: 0,
    accepted: 0,
    expiring: 0,
  });
});

router.get("/metrics", async (_req: any, res: any) => {
  res.json({
    pipeline: 0,
    actions: 0,
    documentHealth: 0,
    lenderActivity: 0,
    offers: 0,
  });
});

export default router;
