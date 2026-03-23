import { Request, Response } from "express";

export const listLenderProductRequirementsHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: [] });
};

export const createLenderProductRequirementHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, created: true });
};

export const updateLenderProductRequirementHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, updated: true });
};

export const deleteLenderProductRequirementHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, deleted: true });
};

// aliases (backward compatibility)
export const fetchLenderRequirements = listLenderProductRequirementsHandler;
