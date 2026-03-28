import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../config";

if (!config.db.url) {
  throw new Error("DATABASE_URL missing");
}

const prismaUrl =
  config.env === "test"
    ? config.db.url || "postgresql://localhost:5432/test"
    : config.db.url;

const adapter = new PrismaPg({ connectionString: prismaUrl });

const prisma = new PrismaClient({
  adapter,
});

export { prisma };
export const db = prisma;
