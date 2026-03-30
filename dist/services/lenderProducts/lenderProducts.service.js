"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lenderProductsService = void 0;
const db_1 = require("../../lib/db");
exports.lenderProductsService = {
    async list() {
        return db_1.db.lenderProduct.findMany();
    },
    async create(data) {
        return db_1.db.lenderProduct.create({ data });
    },
    async update(id, data) {
        return db_1.db.lenderProduct.update({
            where: { id },
            data,
        });
    },
};
