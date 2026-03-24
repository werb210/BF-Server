import { PrismaClient } from "@prisma/client";
import { config } from "../config";

if (!config.db.url) {
  throw new Error("DATABASE_URL missing");
}

const prismaUrl =
  config.env === "test"
    ? config.db.url || "postgresql://localhost:5432/test"
    : config.db.url;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: prismaUrl,
    },
  },
});

export { prisma };
export const db = prisma;
