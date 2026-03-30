"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.prisma = void 0;
exports.getPrisma = getPrisma;
let prismaInstance = null;
function getPrisma() {
    if (!prismaInstance) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PrismaClient } = require("@prisma/client");
        prismaInstance = new PrismaClient();
    }
    return prismaInstance;
}
exports.prisma = new Proxy({}, {
    get: (_target, prop, receiver) => Reflect.get(getPrisma(), prop, receiver),
});
exports.db = exports.prisma;
