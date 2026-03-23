import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { CreateLeadDTO, Lead } from "../models/lead.model";

const leads: Lead[] = [];

export const createLead = (req: Request, res: Response) => {
  const body: CreateLeadDTO = req.body;

  if (!body.companyName || !body.fullName || !body.email) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const newLead: Lead = {
    id: uuid(),
    createdAt: new Date(),
    ...body,
  };

  leads.push(newLead);

  return res.status(201).json({
    success: true,
    leadId: newLead.id,
  });
};

export const fetchLeads = (_req: Request, res: Response) => {
  return res.json(leads);
};
