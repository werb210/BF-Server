import { Router } from "express";
import { createLead, fetchLeads } from "../controllers/lead.controller";

const router = Router();

router.post("/crm/lead", createLead);
router.get("/crm/lead", fetchLeads);

export default router;
