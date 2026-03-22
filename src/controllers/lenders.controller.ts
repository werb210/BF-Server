import { Request, Response } from "express";

export const getLenders = async (_: Request, res: Response) =>
  res.json({ success: true, data: [] });

export const getLenderByIdHandler = getLenders;
export const getLenderWithProducts = getLenders;

export const createLender = async (_: Request, res: Response) =>
  res.json({ success: true, created: true });

export const updateLender = async (_: Request, res: Response) =>
  res.json({ success: true, updated: true });
