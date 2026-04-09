import { lenderProductsService } from "../services/lenderProducts/lenderProducts.service.js";
export const listLenderProductsHandler = async (_req, res) => {
    const data = await lenderProductsService.list();
    res["json"]({ success: true, data });
};
export const createLenderProductHandler = async (req, res) => {
    const data = await lenderProductsService.create(req.body);
    res["json"]({ success: true, data });
};
export const updateLenderProductHandler = async (req, res) => {
    const data = await lenderProductsService.update(String(req.params.id), req.body);
    res["json"]({ success: true, data });
};
