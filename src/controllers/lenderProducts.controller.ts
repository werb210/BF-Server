import { Request, Response } from "express";

export const listLenderProducts = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: [] });
};

export const listLenderProductsHandler = listLenderProducts;

export const createLenderProductHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, created: true });
};

export const updateLenderProductHandler = async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, updated: true });
};
