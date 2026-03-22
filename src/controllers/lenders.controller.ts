import { Handler } from "../types/handler";
import { lenderService } from "../services/lenders/lender.service";

export const getLenders: Handler = async (_req, res) => {
  const data = await lenderService.list();
  res.json({ success: true, data });
};

export const getLenderById: Handler = async (req, res) => {
  const data = await lenderService.getById(req.params.id);
  res.json({ success: true, data });
};

export const createLender: Handler = async (req, res) => {
  const data = await lenderService.create(req.body);
  res.json({ success: true, data });
};

export const updateLender: Handler = async (req, res) => {
  const data = await lenderService.update(req.params.id, req.body);
  res.json({ success: true, data });
};

export const getLenderWithProducts: Handler = async (req, res) => {
  const data = await lenderService.getWithProducts(req.params.id);
  res.json({ success: true, data });
};
