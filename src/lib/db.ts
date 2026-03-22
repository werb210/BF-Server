import { v4 as uuid } from "uuid";

type Lender = { id: string; name: string };
type Product = { id: string; lenderId: string; name: string };

let lenders: Lender[] = [];
let products: Product[] = [];

export const db = {
  lender: {
    findMany: async () => lenders,
    findUnique: async ({ where: { id } }: any) =>
      lenders.find((l) => l.id === id),

    create: async ({ data }: any) => {
      const item = { id: uuid(), ...data };
      lenders.push(item);
      return item;
    },

    update: async ({ where: { id }, data }: any) => {
      const idx = lenders.findIndex((l) => l.id === id);
      lenders[idx] = { ...lenders[idx], ...data };
      return lenders[idx];
    },
  },

  lenderProduct: {
    findMany: async () => products,

    create: async ({ data }: any) => {
      const item = { id: uuid(), ...data };
      products.push(item);
      return item;
    },

    update: async ({ where: { id }, data }: any) => {
      const idx = products.findIndex((p) => p.id === id);
      products[idx] = { ...products[idx], ...data };
      return products[idx];
    },
  },
};
