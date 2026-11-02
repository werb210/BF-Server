// BF_SERVER_v867_BROKER_TOOLS - /api/deal-desk: the broker tools behind the application's Deal desk tab and Settings > Deal tools.
// Each part is its own router; each route checks its own plan feature, role and (for /applications/:id) the caller's
// silo and record visibility.
import { Router } from "express";
import invoices from "./dealDesk/invoices.js"; // BF_SERVER_v867_BROKER_TOOLS_INVOICES
import creditLines from "./dealDesk/creditLines.js"; // BF_SERVER_v867_BROKER_TOOLS_CREDIT_LINES
import rateCards from "./dealDesk/rateCards.js"; // BF_SERVER_v867_BROKER_TOOLS_RATE_CARDS
import scorecards from "./dealDesk/scorecards.js"; // BF_SERVER_v867_BROKER_TOOLS_SCORECARDS
import contracts from "./dealDesk/contracts.js"; // BF_SERVER_v867_BROKER_TOOLS_CONTRACTS
import vendors from "./dealDesk/vendors.js"; // BF_SERVER_v867_BROKER_TOOLS_VENDORS
import creditBureau from "./dealDesk/creditBureau.js"; // BF_SERVER_v867_BROKER_TOOLS_CREDIT_BUREAU

const router = Router();
router.use(invoices);
router.use(creditLines);
router.use(rateCards);
router.use(scorecards);
router.use(contracts);
router.use(vendors);
router.use(creditBureau);

export default router;
