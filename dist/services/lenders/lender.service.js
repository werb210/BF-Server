"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lenderService = void 0;
const db_1 = require("../../lib/db");
exports.lenderService = {
    async list() {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lender.findMany();
    },
    async byId(id) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async withProducts(id) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async create(data) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lender.create({ data });
    },
    async update(id, data) {
        const prisma = (await (0, db_1.getPrisma)());
        return prisma.lender.update({
            where: { id },
            data,
        });
    },
};
