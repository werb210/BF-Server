import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { CreateLeadDTO, Lead } from "../models/lead.model";

const leads: Lead[] = [];
const MAX_LEADS = 500;

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_LEADS) arr.shift();
}

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

  pushBounded(leads, newLead);

  return res.status(201).json({
    success: true,
    leadId: newLead.id,
  });
};

export const fetchLeads = (_req: Request, res: Response) => {
  return res.json(leads.slice(0, 100));
};
