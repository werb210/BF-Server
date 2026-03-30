"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateLenderProductHandler = exports.createLenderProductHandler = exports.listLenderProductsHandler = void 0;
const lenderProducts_service_1 = require("../services/lenderProducts/lenderProducts.service");
const listLenderProductsHandler = async (_req, res) => {
    const data = await lenderProducts_service_1.lenderProductsService.list();
    res["json"]({ success: true, data });
};
exports.listLenderProductsHandler = listLenderProductsHandler;
const createLenderProductHandler = async (req, res) => {
    const data = await lenderProducts_service_1.lenderProductsService.create(req.body);
    res["json"]({ success: true, data });
};
exports.createLenderProductHandler = createLenderProductHandler;
const updateLenderProductHandler = async (req, res) => {
    const data = await lenderProducts_service_1.lenderProductsService.update(String(req.params.id), req.body);
    res["json"]({ success: true, data });
};
exports.updateLenderProductHandler = updateLenderProductHandler;
