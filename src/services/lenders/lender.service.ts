export const lenderService = {
  async list() {
    // TODO: replace with DB
    return [];
  },

  async getById(id: string) {
    return { id };
  },

  async create(data: any) {
    return { id: "new-id", ...data };
  },

  async update(id: string, data: any) {
    return { id, ...data };
  },

  async getWithProducts(id: string) {
    return { id, products: [] };
  },
};
