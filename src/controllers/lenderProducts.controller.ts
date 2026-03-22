import { Handler } from "../types/handler";
import { lenderProductsService } from "../services/lenderProducts/lenderProducts.service";

export const listLenderProducts: Handler = async (_req, res) => {
  const data = await lenderProductsService.list();
  res.json({ success: true, data });
};

export const createLenderProductHandler: Handler = async (req, res) => {
  const data = await lenderProductsService.create(req.body);
  res.json({ success: true, data });
};

export const updateLenderProductHandler: Handler = async (req, res) => {
  const data = await lenderProductsService.update(req.params.id, req.body);
  res.json({ success: true, data });
};
