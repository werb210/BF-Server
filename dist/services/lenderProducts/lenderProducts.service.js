"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lenderProductsService = void 0;
const db_1 = require("../../lib/db");
exports.lenderProductsService = {
    async list() {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lenderProduct.findMany();
    },
    async create(data) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lenderProduct.create({ data });
    },
    async update(id, data) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lenderProduct.update({
            where: { id },
            data,
        });
    },
};
